import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionPeerRouteTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const source = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
  const target = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      [source, target].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })),
    )
    .run()
    .pipe(Effect.orDie)
  return { db, source, target }
})

describe("SessionPeerRoute", () => {
  it.effect("requires a direct user message containing the exact target ID", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const id = SessionMessage.ID.create()
      yield* context.db
        .insert(SessionInputTable)
        .values({
          id,
          session_id: context.source,
          prompt: Prompt.make({ text: `Please contact ${context.target}` }),
          delivery: "steer",
          admitted_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const input = {
        sourceSessionID: context.source,
        targetSessionID: context.target,
        alias: "/root/existing",
        origin: { kind: "user_message" as const, id },
      }
      expect((yield* Effect.exit(SessionPeerRoute.bind(input)))._tag).toBe("Failure")
      yield* SessionPeerRoute.markUserMessage({ sessionID: context.source, messageID: id })
      const route = yield* SessionPeerRoute.bind(input)
      expect(route?.target_session_id).toBe(context.target)
      expect(route?.can_interrupt).toBe(false)
      expect(
        (yield* SessionPeerRoute.resolve({
          sourceSessionID: context.source,
          alias: input.alias,
          capability: "interact",
        })).target_session_id,
      ).toBe(context.target)
      expect(
        (yield* Effect.exit(
          SessionPeerRoute.resolve({ sourceSessionID: context.source, alias: input.alias, capability: "interrupt" }),
        ))._tag,
      ).toBe("Failure")
      expect((yield* SessionPeerRoute.bind(input))?.target_session_id).toBe(context.target)
      const others = yield* context.db
        .select()
        .from(SessionPeerRouteTable)
        .where(eq(SessionPeerRouteTable.source_session_id, context.source))
        .all()
        .pipe(Effect.orDie)
      expect(others).toHaveLength(1)
    }),
  )

  it.effect("rejects alias rebinding and does not treat parent provenance as authorization", () =>
    Effect.gen(function* () {
      const context = yield* setup
      yield* context.db
        .update(SessionTable)
        .set({ parent_id: context.source })
        .where(eq(SessionTable.id, context.target))
        .run()
        .pipe(Effect.orDie)
      expect(
        (yield* Effect.exit(
          SessionPeerRoute.resolve({ sourceSessionID: context.source, alias: "/root/worker", capability: "inspect" }),
        ))._tag,
      ).toBe("Failure")
      const legacy = (yield* SessionPeerRoute.list(context.source)).find((route) => route.target_session_id === context.target)
      expect(legacy?.alias).toBe(`/root/legacy_${context.target}`)
      expect(legacy?.origin_kind).toBe("legacy")
      yield* SessionPeerRoute.bind({
        sourceSessionID: context.source,
        targetSessionID: context.target,
        alias: "/root/worker",
        origin: { kind: "spawn", id: "task-1" },
      })
      const other = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
      yield* context.db.insert(SessionTable).values({
        id: other,
        project_id: Project.ID.global,
        slug: other,
        directory: "/project",
        title: other,
        version: "test",
      }).run().pipe(Effect.orDie)
      const conflict = yield* Effect.exit(SessionPeerRoute.bind({
        sourceSessionID: context.source,
        targetSessionID: other,
        alias: "/root/worker",
        origin: { kind: "spawn", id: "task-2" },
      }))
      expect(conflict._tag).toBe("Failure")
      expect(SessionPeerRoute.validAlias("/root")).toBe(false)
      expect(SessionPeerRoute.validAlias("/root/../worker")).toBe(false)
    }),
  )
})

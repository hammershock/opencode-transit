import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionPeerMessage } from "@opencode-ai/core/session/peer-message"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionPeerMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

for (const sourceBackend of ["v1", "v2"] as const)
  for (const targetBackend of ["v1", "v2"] as const)
    it.effect(`${sourceBackend} → ${targetBackend} request and reply preserve native histories`, () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const source = SessionSchema.ID.create()
        const target = SessionSchema.ID.create()
        const now = Date.now()
        for (const id of [source, target])
          yield* events.publish(SessionV1.Event.Created, {
            sessionID: id,
            info: {
              id,
              projectID: Project.ID.global,
              directory: "/tmp/peer-matrix",
              slug: id,
              title: id,
              version: "test",
              time: { created: now, updated: now },
            },
          })
        for (const [id, backend] of [[source, sourceBackend], [target, targetBackend]] as const)
          if (backend === "v1")
            yield* events.publish(SessionV1.Event.MessageUpdated, {
              sessionID: id,
              info: {
                id: SessionV1.MessageID.make(`msg_${crypto.randomUUID().replaceAll("-", "")}`),
                sessionID: id,
                role: "user",
                agent: "build",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
                time: { created: now },
              },
            })
        yield* SessionPeerRoute.bind({
          sourceSessionID: source,
          targetSessionID: target,
          alias: "/root/worker",
          origin: { kind: "spawn", id: "matrix" },
        })
        const delivered: string[] = []
        const execution = SessionExecution.Service.of({
          active: Effect.succeed(new Set<SessionSchema.ID>()),
          resume: () => Effect.void,
          wake: () => Effect.void,
          wakeAndWait: () => Effect.void,
          interrupt: () => Effect.void,
          generation: () => Effect.succeed(undefined),
          interruptGeneration: () => Effect.succeed("completed" as const),
          requestInterruptExact: () => Effect.succeed(false),
          compactManual: () => Effect.void,
        })
        const deliverLegacy = (row: typeof SessionPeerMessageTable.$inferSelect) =>
          Effect.sync(() => { delivered.push(row.id) })
        const request = yield* SessionPeerMessage.send({
          sourceSessionID: source,
          alias: "/root/worker",
          text: "进展如何？请继续原任务。",
          operationID: `request-${sourceBackend}-${targetBackend}`,
          deliverLegacy,
        }).pipe(Effect.provideService(SessionExecution.Service, execution))
        expect(request.backend).toBe(targetBackend)
        expect(request.delivery).toBe("admitted")
        expect(delivered).toHaveLength(targetBackend === "v1" ? 1 : 0)
        expect(yield* SessionInput.hasPending(db, target, "steer")).toBe(targetBackend === "v2")
        const reply = yield* SessionPeerMessage.send({
          sourceSessionID: target,
          alias: `/contacts/requester_${source.slice(4, 16)}`,
          kind: "reply",
          replyTo: request.id,
          text: "7/20 已完成，继续执行。",
          operationID: `reply-${sourceBackend}-${targetBackend}`,
          deliverLegacy,
        }).pipe(Effect.provideService(SessionExecution.Service, execution))
        expect(reply.backend).toBe(sourceBackend)
        expect(reply.target_session_id).toBe(source)
        expect(reply.request_id).toBe(request.id)
        expect(delivered).toHaveLength((targetBackend === "v1" ? 1 : 0) + (sourceBackend === "v1" ? 1 : 0))
        expect(yield* SessionInput.hasPending(db, source, "steer")).toBe(sourceBackend === "v2")
        expect(
          (yield* db.select().from(SessionPeerMessageTable).where(eq(SessionPeerMessageTable.id, request.id)).get())
            ?.reply_id,
        ).toBe(reply.id)
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, target)).get()).toBeDefined()
      }),
    )

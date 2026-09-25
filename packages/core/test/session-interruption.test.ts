import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInterruption } from "@opencode-ai/core/session/interruption"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionExecutionPauseTable, SessionInterruptionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

describe("SessionInterruption", () => {
  it.effect("does not promote queued work until explicit resume", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const sessionID = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "pause",
          directory: "/project",
          title: "pause",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const input = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: Prompt.make({ text: "queued work" }),
        delivery: "queue",
      })
      yield* db
        .insert(SessionExecutionPauseTable)
        .values({ session_id: sessionID, operation_id: "user-stop", time_created: Date.now() })
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBeUndefined()
      const waiting = yield* SessionInterruption.waitUntilResumed(sessionID).pipe(Effect.forkChild)
      yield* SessionInterruption.resumePending(sessionID)
      yield* Fiber.join(waiting)
      expect((yield* SessionInput.promoteNextQueued(db, events, sessionID))?.id).toBe(input.id)
    }),
  )

  it.effect("records a user stop, pauses old queued work, and leaves the Session reusable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "stop",
            directory: "/project",
            title: "stop",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const started = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, never>({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const execution = SessionExecution.Service.of({
          active: coordinator.active,
          resume: coordinator.run,
          wake: coordinator.wake,
          wakeAndWait: coordinator.wakeAndWait,
          interrupt: coordinator.interrupt,
          generation: coordinator.generation,
          interruptGeneration: coordinator.interruptGeneration,
          requestInterruptExact: () => Effect.succeed(false),
          compactManual: () => Effect.void,
        })
        const run = yield* coordinator.run(sessionID).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const input = {
          sessionID,
          operationID: crypto.randomUUID(),
          actor: { kind: "user" as const, id: "direct_user" },
        }
        const receipts = yield* Effect.all([SessionInterruption.request(input), SessionInterruption.request(input)], {
          concurrency: "unbounded",
        }).pipe(Effect.provideService(SessionExecution.Service, execution))
        const receipt = receipts[0]
        expect(receipt?.state).toBe("interrupted")
        expect(receipts[1]?.state).toBe("interrupted")
        expect((yield* SessionInterruption.latest(sessionID))?.actor_kind).toBe("user")
        expect(
          (yield* db
            .select()
            .from(SessionExecutionPauseTable)
            .where(eq(SessionExecutionPauseTable.session_id, sessionID))
            .get())?.operation_id,
        ).toBe(input.operationID)
        expect(
          (yield* SessionInterruption.request(input).pipe(Effect.provideService(SessionExecution.Service, execution)))
            ?.state,
        ).toBe("interrupted")
        yield* SessionInterruption.resumePending(sessionID)
        expect(
          yield* db
            .select()
            .from(SessionExecutionPauseTable)
            .where(eq(SessionExecutionPauseTable.session_id, sessionID))
            .get(),
        ).toBeUndefined()
        expect(
          (yield* db
            .select()
            .from(SessionInterruptionTable)
            .where(eq(SessionInterruptionTable.operation_id, input.operationID))
            .get())?.state,
        ).toBe("interrupted")
        yield* Fiber.await(run)
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())?.id).toBe(sessionID)
      }),
    ),
  )
})

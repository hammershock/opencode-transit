import { describe, expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable, SessionTaskSteerTable, SessionTaskTable } from "@opencode-ai/core/session/sql"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskDelivery } from "@opencode-ai/core/session/task-delivery"
import { SessionTaskOwner } from "@opencode-ai/core/session/task-owner"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionTaskDelivery", () => {
  test("requires the old controller process to exit before resuming the original frozen input", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "task-reconcile.sqlite")
    const controller = Bun.spawn([process.execPath, "-e", "console.log('ready'); await Bun.sleep(10_000)"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const reader = controller.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value)).toContain("ready")
      const oldStart = await SessionTaskOwner.processIdentity(controller.pid)
      expect(oldStart).toBeDefined()
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionExecution.node]),
        [
          [Database.node, Database.layerFromPath(filename)],
          [SessionExecution.node, SessionExecution.noopLayer],
        ],
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const db = database.db
          const events = yield* EventV2.Service
          const root = SessionSchema.ID.create()
          const child = SessionSchema.ID.create()
          const first = SessionMessage.ID.create()
          const second = SessionMessage.ID.create()
          const third = SessionMessage.ID.create()
          const now = Date.now()
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
            .run()
          const info = {
            id: root,
            slug: "reconcile-root",
            projectID: Project.ID.global,
            directory: AbsolutePath.make(temp.path),
            title: "root",
            version: "test",
            time: { created: now, updated: now },
          }
          const base = {
            rootSessionID: root,
            parentSessionID: root,
            childSessionID: child,
            description: "work",
            agentID: "build",
            locationRevision: 0,
            backend: "v2" as const,
          }
          yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
          yield* events.publish(SessionV1.Event.Created, {
            sessionID: child,
            info: { ...info, id: child, slug: "reconcile-child", parentID: root },
            task: { ...base, inputID: first, parentMessageID: "msg_parent_a", callID: "call-a", promptDigest: "a" },
            taskInput: { messageID: first, prompt: Prompt.make({ text: "A" }), delivery: "queue" },
          })
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: child,
            messageID: first,
            prompt: Prompt.make({ text: "A" }),
            delivery: "queue",
            timestamp: DateTime.makeUnsafe(now),
          })
          yield* db
            .update(SessionTaskTable)
            .set({ owner_pid: controller.pid, owner_start: oldStart!, owner_generation: "old-generation" })
            .where(eq(SessionTaskTable.input_id, first))
            .run()
          yield* SessionInput.admit(db, events, {
            id: second,
            sessionID: child,
            prompt: Prompt.make({ text: "B" }),
            delivery: "queue",
            task: {
              kind: "invocation",
              admission: {
                ...base,
                inputID: second,
                parentMessageID: "msg_parent_b",
                callID: "call-b",
                promptDigest: "b",
              },
            },
          })
          yield* SessionInput.admit(db, events, {
            id: third,
            sessionID: child,
            prompt: Prompt.make({ text: "C" }),
            delivery: "queue",
            task: {
              kind: "invocation",
              admission: {
                ...base,
                inputID: third,
                parentMessageID: "msg_parent_c",
                callID: "call-c",
                promptDigest: "c",
              },
            },
          })
          yield* SessionTask.archiveUnknown(database, events, {
            inputID: first,
            childSessionID: child,
            operationID: "archive-a",
            actor: { kind: "user", id: "user" },
          })
          expect((yield* SessionTask.find(db, second))?.eligibility).toBe("frozen")
          expect((yield* SessionTask.find(db, third))?.eligibility).toBe("frozen")
          const cancelled = yield* SessionTaskDelivery.reconcile({
            childSessionID: child,
            inputID: third,
            invocation: { parentSessionID: root, parentMessageID: "msg_parent_c", callID: "call-c" },
            operationID: "cancel-c",
            actor: { kind: "user", id: "user" },
            disposition: "cancel_pending",
          })
          expect(cancelled.eligibility).toBe("cancelled")
          expect((yield* SessionTask.find(db, third))?.outcome).toBe("cancelled")
          const operation = {
            childSessionID: child,
            inputID: second,
            invocation: { parentSessionID: root, parentMessageID: "msg_parent_b", callID: "call-b" },
            operationID: "resume-b",
            actor: { kind: "user" as const, id: "user" },
            disposition: "resume_pending" as const,
          }
          expect(Exit.isFailure(yield* SessionTaskDelivery.reconcile(operation).pipe(Effect.exit))).toBe(true)
          process.kill(controller.pid, "SIGKILL")
          yield* Effect.promise(() => controller.exited)
          const receipt = yield* SessionTaskDelivery.reconcile(operation)
          expect(receipt.eligibility).toBe("eligible")
          expect(receipt.inputID).toBe(second)
          expect((yield* SessionTaskDelivery.reconcile(operation)).inputID).toBe(second)
          expect((yield* SessionInput.promoteNextQueued(db, events, child))?.id).toBe(second)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      if (controller.exitCode === null) controller.kill()
      await controller.exited
    }
  })

  test("guards steer and queued follow-up with a real local owner lease", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "task-delivery.sqlite")
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionExecution.node]),
      [
        [Database.node, Database.layerFromPath(filename)],
        [SessionExecution.node, SessionExecution.noopLayer],
      ],
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const db = database.db
        const events = yield* EventV2.Service
        const root = SessionSchema.ID.create()
        const child = SessionSchema.ID.create()
        const inputID = SessionMessage.ID.create()
        const started = Date.now()
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
          .run()
        const info = {
          id: root,
          slug: "task-delivery-root",
          projectID: Project.ID.global,
          directory: AbsolutePath.make(temp.path),
          title: "root",
          version: "test",
          time: { created: started, updated: started },
        }
        yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
        const admission = {
          inputID,
          rootSessionID: root,
          parentSessionID: root,
          parentMessageID: "msg_delivery_parent",
          callID: "call-delivery-initial",
          promptDigest: "initial",
          childSessionID: child,
          description: "initial work",
          agentID: "build",
          locationRevision: 0,
          backend: "v2" as const,
        }
        yield* events.publish(
          SessionV1.Event.Created,
          {
            sessionID: child,
            info: { ...info, id: child, slug: "task-delivery-child", parentID: root },
            task: admission,
            taskInput: { messageID: inputID, prompt: Prompt.make({ text: "initial" }), delivery: "queue" },
          },
          { commit: () => SessionTask.validate(db, inputID) },
        )
        const invocation = {
          parentSessionID: root,
          parentMessageID: admission.parentMessageID,
          callID: admission.callID,
        }
        yield* SessionTaskOwner.withLease(
          database,
          { childSessionID: child, inputID },
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: child,
              messageID: inputID,
              timestamp: DateTime.makeUnsafe(started),
              prompt: Prompt.make({ text: "initial" }),
              delivery: "queue",
            })
            const receipt = yield* SessionTaskDelivery.send({
              childSessionID: child,
              invocationInputID: inputID,
              invocation,
              operationID: "send-1",
              text: "more context",
            })
            expect(receipt.state).toBe("admitted")
            const duplicate = yield* SessionTaskDelivery.send({
              childSessionID: child,
              invocationInputID: inputID,
              invocation,
              operationID: "send-1",
              text: "more context",
            })
            expect(duplicate.inputID).toBe(receipt.inputID)
            const conflict = yield* SessionTaskDelivery.send({
              childSessionID: child,
              invocationInputID: inputID,
              invocation,
              operationID: "send-1",
              text: "different context",
            }).pipe(Effect.exit)
            expect(Exit.isFailure(conflict)).toBe(true)
            const followup = yield* SessionTaskDelivery.followup({
              childSessionID: child,
              invocation: { parentSessionID: root, parentMessageID: "msg_delivery_next", callID: "call-delivery-next" },
              description: "next work",
              agentID: "build",
              text: "next",
            })
            expect(followup.state).toBe("queued")
            expect((yield* SessionTask.find(db, followup.inputID))?.state).toBe("queued")
            yield* db.update(SessionTable).set({ location_revision: 1 }).where(eq(SessionTable.id, child)).run()
            const stale = yield* SessionTaskDelivery.send({
              childSessionID: child,
              invocationInputID: inputID,
              invocation,
              operationID: "send-after-rebind",
              text: "stale",
            }).pipe(Effect.exit)
            expect(Exit.isFailure(stale)).toBe(true)
            expect(
              yield* db
                .select()
                .from(SessionTaskSteerTable)
                .where(eq(SessionTaskSteerTable.operation_id, "send-after-rebind"))
                .get(),
            ).toBeUndefined()
          }),
        )
        const after = yield* SessionTaskDelivery.send({
          childSessionID: child,
          invocationInputID: inputID,
          invocation,
          operationID: "send-after-owner",
          text: "late",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(after)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})

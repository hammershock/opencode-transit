import { describe, expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionTaskControl", () => {
  test("fixed stop cancels admitted and queued inputs, then never expands to a later D", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "task-stop.sqlite")
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionExecution.node]),
      [
        [Database.node, Database.layerFromPath(filename)],
        [SessionExecution.node, SessionExecution.noopLayer],
      ],
    )
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const root = SessionSchema.ID.create()
        const child = SessionSchema.ID.create()
        const a = SessionMessage.ID.create()
        const b = SessionMessage.ID.create()
        const c = SessionMessage.ID.create()
        const d = SessionMessage.ID.create()
        const e = SessionMessage.ID.create()
        const f = SessionMessage.ID.create()
        const now = Date.now()
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
          .run()
        const info = {
          id: root,
          slug: "stop-root",
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
          info: { ...info, id: child, slug: "stop-child", parentID: root },
          task: { ...base, inputID: a, parentMessageID: "msg-a", callID: "call-a", promptDigest: "a" },
          taskInput: { messageID: a, prompt: Prompt.make({ text: "A" }), delivery: "queue" },
        })
        for (const [id, name] of [
          [b, "B"],
          [c, "C"],
        ] as const)
          yield* SessionInput.admit(database.db, events, {
            id,
            sessionID: child,
            prompt: Prompt.make({ text: name }),
            delivery: "queue",
            task: {
              kind: "invocation",
              admission: {
                ...base,
                inputID: id,
                parentMessageID: `msg-${name}`,
                callID: `call-${name}`,
                promptDigest: name,
              },
            },
          })
        expect((yield* SessionTask.find(database.db, a))?.state).toBe("admitted")
        expect((yield* SessionTask.find(database.db, b))?.state).toBe("queued")
        const operation = {
          parentSessionID: root,
          childSessionID: child,
          operationID: "stop-once",
          actor: { kind: "parent" as const, id: root },
        }
        const first = yield* SessionTaskControl.stop(operation)
        expect(first.data).toEqual([
          { inputID: a, state: "cancelled_pending" },
          { inputID: b, state: "cancelled_pending" },
          { inputID: c, state: "cancelled_pending" },
        ])
        expect((yield* SessionTask.find(database.db, a))?.outcome).toBe("cancelled")
        expect(yield* SessionInput.promoteNextQueued(database.db, events, child)).toBeUndefined()
        yield* SessionInput.admit(database.db, events, {
          id: d,
          sessionID: child,
          prompt: Prompt.make({ text: "D" }),
          delivery: "queue",
          task: {
            kind: "invocation",
            admission: { ...base, inputID: d, parentMessageID: "msg-d", callID: "call-d", promptDigest: "d" },
          },
        })
        expect((yield* SessionTask.find(database.db, d))?.state).toBe("admitted")
        for (const [id, name] of [
          [e, "E"],
          [f, "F"],
        ] as const)
          yield* SessionInput.admit(database.db, events, {
            id,
            sessionID: child,
            prompt: Prompt.make({ text: name }),
            delivery: "queue",
            task: {
              kind: "invocation",
              admission: {
                ...base,
                inputID: id,
                parentMessageID: `msg-${name}`,
                callID: `call-${name}`,
                promptDigest: name,
              },
            },
          })
        yield* database.db.update(SessionTable).set({ location_revision: 1 }).where(eq(SessionTable.id, child)).run()
        expect(
          yield* SessionTaskControl.interrupt({
            childSessionID: child,
            inputID: e,
            invocation: { parentSessionID: root, parentMessageID: "msg-E", callID: "call-E" },
            actor: { kind: "parent", id: root },
          }),
        ).toEqual({ inputID: e, state: "cancelled_pending" })
        expect((yield* SessionTask.find(database.db, e))?.outcome).toBe("cancelled")
        expect((yield* SessionTask.find(database.db, f))?.state).toBe("queued")
        expect(yield* SessionTaskControl.stop(operation)).toEqual(first)
        expect((yield* SessionTask.find(database.db, d))?.state).toBe("admitted")
        expect((yield* SessionTask.find(database.db, f))?.state).toBe("queued")
        expect(
          Exit.isFailure(
            yield* SessionTaskControl.stop({ ...operation, actor: { kind: "user", id: "other" } }).pipe(Effect.exit),
          ),
        ).toBe(true)
        return { operation, d, first }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* SessionTaskControl.stop(saved.operation)).toEqual(saved.first)
        expect((yield* SessionTask.find(database.db, saved.d))?.state).toBe("admitted")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    const retry = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixture", "task-stop-retry.ts"),
        filename,
        saved.operation.parentSessionID,
        saved.operation.childSessionID,
        saved.operation.operationID,
        saved.d,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(retry.stdout).text(),
      new Response(retry.stderr).text(),
      retry.exited,
    ])
    expect(exit, stderr).toBe(0)
    const line = stdout.split("\n").find((item) => item.startsWith("TASK_STOP_RETRY:"))
    expect(line, stderr).toBeDefined()
    expect(JSON.parse(line!.slice("TASK_STOP_RETRY:".length))).toEqual({ receipt: saved.first, later: "admitted" })
  }, 30_000)
})

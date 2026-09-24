import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Exit } from "effect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable, SessionTaskSteerTable, SessionTaskTable } from "@opencode-ai/core/session/sql"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskView } from "@opencode-ai/core/session/task-view"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Prompt } from "@opencode-ai/schema/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const fixture = Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.apply(db)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  const root = SessionSchema.ID.create()
  yield* db
    .insert(SessionTable)
    .values({
      id: root,
      project_id: Project.ID.global,
      slug: "root",
      directory: "/project",
      title: "root",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return { db, root }
})

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const eventIt = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

describe("SessionTask durable projection", () => {
  eventIt.effect("projects one atomic V2 inbox invocation and an exact steer receipt", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const root = SessionSchema.ID.create()
      const child = SessionSchema.ID.create()
      const info = {
        id: root,
        slug: "task-inbox-root",
        projectID: Project.ID.global,
        directory: "/project",
        title: "root",
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: child,
        info: { ...info, id: child, parentID: root, slug: "task-inbox-child" },
      })
      const inputID = SessionMessage.ID.create()
      const initialTime = DateTime.makeUnsafe(Date.now())
      const admission = {
        inputID,
        rootSessionID: root,
        parentSessionID: root,
        parentMessageID: "msg_task_inbox_parent",
        callID: "call-task-inbox",
        promptDigest: "first-digest",
        childSessionID: child,
        description: "inbox child",
        agentID: "build",
        locationRevision: 0,
        backend: "v2" as const,
      }
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID: child,
        messageID: inputID,
        timestamp: initialTime,
        prompt: Prompt.make({ text: "first" }),
        delivery: "queue",
        task: { kind: "invocation", admission },
      })
      expect((yield* SessionTask.find(db, inputID))?.state).toBe("admitted")
      expect(
        (yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, inputID)).get())?.delivery,
      ).toBe("queue")
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: child,
        messageID: inputID,
        timestamp: initialTime,
        prompt: Prompt.make({ text: "first" }),
        delivery: "queue",
      })
      expect((yield* SessionTask.find(db, inputID))?.state).toBe("active")
      const steerID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID: child,
        messageID: steerID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        prompt: Prompt.make({ text: "update" }),
        delivery: "steer",
        task: {
          kind: "steer",
          invocationInputID: inputID,
          operationID: "steer-operation",
          promptDigest: "update-digest",
        },
      })
      expect(
        (yield* db.select().from(SessionTaskSteerTable).where(eq(SessionTaskSteerTable.input_id, steerID)).get())
          ?.state,
      ).toBe("admitted")
      const promotedSteerID = SessionMessage.ID.create()
      const promotedTime = DateTime.makeUnsafe(Date.now())
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID: child,
        messageID: promotedSteerID,
        timestamp: promotedTime,
        prompt: Prompt.make({ text: "second update" }),
        delivery: "steer",
        task: {
          kind: "steer",
          invocationInputID: inputID,
          operationID: "second-steer-operation",
          promptDigest: "second-update-digest",
        },
      })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: child,
        messageID: promotedSteerID,
        timestamp: promotedTime,
        prompt: Prompt.make({ text: "second update" }),
        delivery: "steer",
      })
      expect(
        (yield* db
          .select()
          .from(SessionTaskSteerTable)
          .where(eq(SessionTaskSteerTable.input_id, promotedSteerID))
          .get())?.state,
      ).toBe("promoted")
      yield* SessionTask.settle(db, events, { inputID, childSessionID: child, outcome: "completed" })
      expect(
        (yield* db.select().from(SessionTaskSteerTable).where(eq(SessionTaskSteerTable.input_id, steerID)).get())
          ?.state,
      ).toBe("not_delivered")
      expect(
        (yield* db
          .select()
          .from(SessionTaskSteerTable)
          .where(eq(SessionTaskSteerTable.input_id, promotedSteerID))
          .get())?.state,
      ).toBe("promoted")
    }),
  )

  eventIt.effect("serializes simultaneous promotion against the final root slot", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const root = SessionSchema.ID.create()
      const rootInfo = {
        id: root,
        slug: "quota-root",
        projectID: Project.ID.global,
        directory: "/project",
        title: "root",
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: root, info: rootInfo })
      const children = Array.from({ length: 9 }, () => SessionSchema.ID.create())
      yield* Effect.forEach(children, (child, index) =>
        events.publish(SessionV1.Event.Created, {
          sessionID: child,
          info: { ...rootInfo, id: child, slug: `child-${index}`, parentID: root },
          ...(index < 7
            ? {
                task: {
                  inputID: `msg_promote_${index}`,
                  rootSessionID: root,
                  parentSessionID: root,
                  parentMessageID: `msg_parent_promote_${index}`,
                  callID: `call-promote-${index}`,
                  promptDigest: "digest",
                  childSessionID: child,
                  description: "task",
                  agentID: "build",
                  locationRevision: 0,
                  backend: "legacy" as const,
                },
              }
            : {}),
        }),
      )
      yield* Effect.forEach(children.slice(7), (child, index) =>
        db
          .insert(SessionTaskTable)
          .values({
            input_id: `msg_promote_${index + 7}`,
            root_session_id: root,
            parent_session_id: root,
            parent_message_id: `msg_parent_promote_${index + 7}`,
            call_id: `call-promote-${index + 7}`,
            prompt_digest: "digest",
            child_session_id: child,
            description: "task",
            agent_id: "build",
            location_revision: 0,
            state: "queued",
            backend: "legacy",
            time_created: Date.now(),
          })
          .run()
          .pipe(Effect.orDie),
      )
      const attempts = yield* Effect.forEach(
        children.slice(7),
        (child, index) =>
          SessionTask.promote(db, events, { inputID: `msg_promote_${index + 7}`, childSessionID: child }).pipe(
            Effect.exit,
          ),
        { concurrency: "unbounded" },
      )
      expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
      expect(attempts.filter(Exit.isFailure)).toHaveLength(1)
      const rows = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.root_session_id, root)).all()
      expect(rows.filter((row) => row.state === "active" || row.state === "admitted")).toHaveLength(8)
      expect(rows.filter((row) => row.state === "queued")).toHaveLength(1)
    }),
  )

  eventIt.effect("projects child events and honors the parent deletion tombstone", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const root = SessionSchema.ID.create()
      const child = SessionSchema.ID.create()
      const rootInfo = {
        id: root,
        slug: "root",
        projectID: Project.ID.global,
        directory: "/project",
        title: "root",
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      const childInfo = {
        ...rootInfo,
        id: child,
        slug: "child",
        parentID: root,
        title: "child",
      }
      const admission = {
        inputID: "msg_event_admitted",
        rootSessionID: root,
        parentSessionID: root,
        parentMessageID: "msg_parent_event",
        callID: "call-event",
        promptDigest: "digest",
        childSessionID: child,
        description: "event child",
        agentID: "build",
        locationRevision: 0,
        backend: "legacy" as const,
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: root, info: rootInfo })
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: child, info: childInfo, task: admission },
        { commit: () => SessionTask.validate(db, admission.inputID) },
      )
      expect((yield* SessionTask.find(db, admission.inputID))?.state).toBe("admitted")
      yield* SessionTask.promote(db, events, { inputID: admission.inputID, childSessionID: child })
      yield* SessionTask.archiveUnknown(yield* Database.Service, events, {
        inputID: admission.inputID,
        childSessionID: child,
        operationID: "archive-event",
        actor: { kind: "user", id: "user-test" },
      })
      const archived = yield* SessionTask.find(db, admission.inputID)
      expect(archived?.abandoned_unknown).toBe(true)
      expect(archived?.outcome).toBeNull()
      expect(archived?.state).toBe("active")
      yield* SessionTask.archiveUnknown(yield* Database.Service, events, {
        inputID: admission.inputID,
        childSessionID: child,
        operationID: "archive-event",
        actor: { kind: "user", id: "user-test" },
      })
      yield* SessionTask.settle(db, events, {
        inputID: admission.inputID,
        childSessionID: child,
        outcome: "completed",
        resultMessageID: "msg_exact_result",
      })
      const stored = yield* SessionTask.find(db, admission.inputID)
      expect(stored?.outcome).toBe("completed")
      expect(stored?.result_message_id).toBe("msg_exact_result")
      const durable = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, child))
        .all()
        .pipe(Effect.orDie)
      expect(durable.map((event) => event.type)).toContain(EventV2.versionedType(SessionTaskEvent.Promoted.type, 1))
      expect(durable.map((event) => event.type)).toContain(EventV2.versionedType(SessionTaskEvent.Settled.type, 1))

      yield* events.publish(SessionV1.Event.Deleted, { sessionID: root, info: rootInfo })
      expect(yield* SessionTask.find(db, admission.inputID)).toBeUndefined()
      yield* events.publish(SessionTaskEvent.Admitted, {
        sessionID: child,
        admission: { ...admission, inputID: "msg_late", parentMessageID: "msg_late_parent", callID: "call-late" },
        timestamp: Date.now(),
      })
      expect(yield* SessionTask.find(db, "msg_late")).toBeUndefined()
    }),
  )

  test("replays settled identity and a late admission through separate database instances", async () => {
    await using temp = await tmpdir()
    const layer = (name: string) =>
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(path.join(temp.path, name))],
      ])
    const root = SessionSchema.ID.create()
    const child = SessionSchema.ID.create()
    const rootInfo = {
      id: root,
      slug: "root",
      projectID: Project.ID.global,
      directory: "/project",
      title: "root",
      version: "test",
      time: { created: Date.now(), updated: Date.now() },
    }
    const admission = {
      inputID: "msg_replay_input",
      rootSessionID: root,
      parentSessionID: root,
      parentMessageID: "msg_replay_parent",
      callID: "call-replay",
      promptDigest: "digest",
      childSessionID: child,
      description: "replay child",
      agentID: "build",
      locationRevision: 0,
      backend: "legacy" as const,
    }
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        yield* events.publish(SessionV1.Event.Created, { sessionID: root, info: rootInfo })
        yield* events.publish(
          SessionV1.Event.Created,
          { sessionID: child, info: { ...rootInfo, id: child, parentID: root, slug: "child" }, task: admission },
          { commit: () => SessionTask.validate(db, admission.inputID) },
        )
        yield* SessionTask.promote(db, events, { inputID: admission.inputID, childSessionID: child })
        yield* SessionTask.settle(db, events, {
          inputID: admission.inputID,
          childSessionID: child,
          outcome: "completed",
          resultMessageID: "msg_replay_result",
        })
        yield* events.publish(SessionV1.Event.Deleted, { sessionID: root, info: rootInfo })
        yield* events.publish(SessionTaskEvent.Admitted, {
          sessionID: child,
          admission: {
            ...admission,
            inputID: "msg_after_delete",
            parentMessageID: "msg_after_delete_parent",
            callID: "call-after-delete",
          },
          timestamp: Date.now(),
        })
        const rows = yield* db
          .select()
          .from(EventTable)
          .orderBy(sql`rowid`)
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({
          id: row.id,
          type: row.type,
          aggregateID: row.aggregate_id,
          seq: row.seq,
          data: row.data,
        }))
      }).pipe(Effect.provide(layer("source.sqlite")), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        for (const record of records.slice(0, 4)) yield* events.replay(record)
        expect((yield* SessionTask.find(db, admission.inputID))?.result_message_id).toBe("msg_replay_result")
        for (const record of records.slice(4)) yield* events.replay(record)
        expect(yield* SessionTask.find(db, admission.inputID)).toBeUndefined()
        expect(yield* SessionTask.find(db, "msg_after_delete")).toBeUndefined()
      }).pipe(Effect.provide(layer("target.sqlite")), Effect.scoped),
    )
  })
})

describe("SessionTask admission", () => {
  test("paginates direct children and invocations behind fixed enumeration bounds", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const ids = Array.from({ length: 4 }, () => SessionSchema.ID.create())
        for (const [index, id] of ids.slice(0, 3).entries()) {
          yield* db
            .insert(SessionTable)
            .values({
              id,
              project_id: Project.ID.global,
              parent_id: root,
              slug: `child-${index}`,
              directory: "/project/private",
              title: `child-${index}`,
              version: "test",
              time_created: index + 1,
            })
            .run()
            .pipe(Effect.orDie)
        }
        const database = { db, filename: ":memory:" }
        const first = yield* SessionTaskView.children(database, { parentSessionID: root, limit: 2 })
        expect(first.data.map((item) => item.target.task_id)).toEqual(ids.slice(0, 2))
        expect(first.next).toBeDefined()
        yield* db
          .insert(SessionTable)
          .values({
            id: ids[3],
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child-3",
            directory: "/project/private",
            title: "child-3",
            version: "test",
            time_created: 4,
          })
          .run()
          .pipe(Effect.orDie)
        const second = yield* SessionTaskView.children(database, {
          parentSessionID: root,
          cursor: first.next,
          limit: 2,
        })
        expect(second.data.map((item) => item.target.task_id)).toEqual([ids[2]])
        expect(second.next).toBeUndefined()
        const deletionPage = yield* SessionTaskView.children(database, { parentSessionID: root, limit: 1 })
        yield* db.delete(SessionTable).where(eq(SessionTable.id, ids[3])).run().pipe(Effect.orDie)
        const replacement = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: replacement,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "replacement",
            directory: "/project/private",
            title: "replacement",
            version: "test",
            time_created: 4,
          })
          .run()
          .pipe(Effect.orDie)
        const afterDeletion = yield* SessionTaskView.children(database, {
          parentSessionID: root,
          cursor: deletionPage.next,
          limit: 3,
        })
        expect(afterDeletion.data.map((item) => item.target.task_id)).toEqual(ids.slice(1, 3))
        const foreign = yield* SessionTaskView.children(database, {
          parentSessionID: ids[0],
          cursor: first.next,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(foreign)).toBe(true)

        for (const index of [0, 1, 2])
          yield* db
            .insert(SessionTaskTable)
            .values({
              input_id: `msg_status_${index}`,
              root_session_id: root,
              parent_session_id: root,
              parent_message_id: `msg_parent_status_${index}`,
              call_id: `call-status-${index}`,
              prompt_digest: "status",
              child_session_id: ids[0],
              description: "inspect",
              agent_id: "build",
              location_revision: 0,
              state: "settled",
              backend: "legacy",
              outcome: "completed",
              time_created: index + 1,
            })
            .run()
            .pipe(Effect.orDie)
        const history = yield* SessionTaskView.invocations(database, {
          parentSessionID: root,
          childSessionID: ids[0],
          limit: 2,
        })
        expect(history.data.map((item) => item.target.invocation?.call_id)).toEqual(["call-status-0", "call-status-1"])
        expect(history.next).toBeDefined()
        yield* db
          .insert(SessionTaskTable)
          .values({
            input_id: "msg_status_3",
            root_session_id: root,
            parent_session_id: root,
            parent_message_id: "msg_parent_status_3",
            call_id: "call-status-3",
            prompt_digest: "status",
            child_session_id: ids[0],
            description: "inspect",
            agent_id: "build",
            location_revision: 0,
            state: "settled",
            backend: "legacy",
            outcome: "completed",
            time_created: 4,
          })
          .run()
          .pipe(Effect.orDie)
        const later = yield* SessionTaskView.invocations(database, {
          parentSessionID: root,
          childSessionID: ids[0],
          cursor: history.next,
          limit: 2,
        })
        expect(later.data.map((item) => item.target.invocation?.call_id)).toEqual(["call-status-2"])
        expect(later.next).toBeUndefined()
        const deletionHistory = yield* SessionTaskView.invocations(database, {
          parentSessionID: root,
          childSessionID: ids[0],
          limit: 1,
        })
        yield* db.delete(SessionTaskTable).where(eq(SessionTaskTable.input_id, "msg_status_3")).run().pipe(Effect.orDie)
        yield* db
          .insert(SessionTaskTable)
          .values({
            input_id: "msg_status_4",
            root_session_id: root,
            parent_session_id: root,
            parent_message_id: "msg_parent_status_4",
            call_id: "call-status-4",
            prompt_digest: "status",
            child_session_id: ids[0],
            description: "inspect",
            agent_id: "build",
            location_revision: 0,
            state: "settled",
            backend: "legacy",
            outcome: "completed",
            time_created: 4,
          })
          .run()
          .pipe(Effect.orDie)
        const afterHistoryDeletion = yield* SessionTaskView.invocations(database, {
          parentSessionID: root,
          childSessionID: ids[0],
          cursor: deletionHistory.next,
          limit: 4,
        })
        expect(afterHistoryDeletion.data.map((item) => item.target.invocation?.call_id)).toEqual([
          "call-status-1",
          "call-status-2",
        ])
      }),
    )
  })

  test("legacy TaskPromptOps cannot advertise incomplete controls", async () => {
    const result = SessionTaskCapability.evaluate(SessionTaskCapability.legacyTaskPromptOps)
    expect(result.status).toBe("unsupported")
    expect(result.status === "unsupported" ? result.missing : []).toContain("durable_queue")
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(SessionTaskCapability.requireControl(SessionTaskCapability.legacyTaskPromptOps)),
      ),
    ).toBe(true)
  })

  test("reads bounded durable status without inventing a live owner", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const child = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child",
            directory: "/project/private",
            title: "child",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* SessionTask.admit(db, {
          inputID: "msg_view",
          rootSessionID: root,
          parentSessionID: root,
          parentMessageID: "msg_parent_view",
          callID: "call-view",
          promptDigest: "digest",
          childSessionID: child,
          description: "inspect",
          agentID: "build",
          locationRevision: 0,
          backend: "legacy",
        })
        const database = { db, filename: ":memory:" }
        const admitted = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(admitted.lifecycle).toBe("admitted")
        expect(admitted.runtime).toBe("unknown")
        expect(admitted.location.directory).toBeUndefined()
        expect(admitted.target.invocation?.call_id).toBe("call-view")
        expect(admitted.input_id).toBe("msg_view")
        expect(admitted.root_quota).toMatchObject({ active_used: 1, active_limit: 8, pending_used: 0 })
        expect(admitted.owner_safety).toBe("unknown")
        const direct = yield* SessionTaskView.read(database, {
          parentSessionID: root,
          childSessionID: child,
          invocation: admitted.target.invocation,
        })
        expect(direct.location.directory).toBeUndefined()
        yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('msg_status_assistant', ${child}, 1, 1, '{"role":"assistant","parentID":"msg_view"}')`)
        yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES ('prt_status_tool', 'msg_status_assistant', ${child}, 1, 1,
            '{"type":"tool","tool":"question","callID":"call-live","state":{"status":"running","time":{"start":1}}}')`)
        const observed = { ...direct, lifecycle: "active" as const, runtime: "observed" as const }
        const wrongCall = yield* SessionTaskView.withLivePhase(database, observed, {
          permissions: [{ sessionID: child, source: { messageID: "msg_status_assistant", callID: "call-other" } }],
          questions: [],
        })
        expect(wrongCall.phase).toBe(direct.phase)
        const permission = yield* SessionTaskView.withLivePhase(database, observed, {
          permissions: [{ sessionID: child, source: { messageID: "msg_status_assistant", callID: "call-live" } }],
          questions: [],
        })
        expect(permission.phase).toBe("permission")
        const question = yield* SessionTaskView.withLivePhase(database, observed, {
          permissions: [],
          questions: [{ sessionID: child, tool: { messageID: "msg_status_assistant", callID: "call-live" } }],
        })
        expect(question.phase).toBe("question")
        const historical = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: historical,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "old",
            directory: "/project",
            title: "old child",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const legacy = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: historical })
        expect(legacy.lifecycle).toBe("unscoped_legacy")
        expect(legacy.target.invocation).toBeUndefined()
        const forbidden = yield* SessionTaskView.read(database, {
          parentSessionID: SessionSchema.ID.create(),
          childSessionID: child,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(forbidden)).toBe(true)
      }),
    )
  })

  test("bounds result summaries by UTF-8 bytes without splitting characters", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const child = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "result-child",
            directory: "/project/private",
            title: "result-child",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* SessionTask.admit(db, {
          inputID: "msg_utf8_input",
          rootSessionID: root,
          parentSessionID: root,
          parentMessageID: "msg_utf8_parent",
          callID: "call-utf8",
          promptDigest: "digest",
          childSessionID: child,
          description: "inspect",
          agentID: "build",
          locationRevision: 0,
          backend: "legacy",
        })
        yield* db.run(
          sql`UPDATE session_task SET result_message_id = 'msg_utf8_result' WHERE input_id = 'msg_utf8_input'`,
        )
        yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('msg_utf8_result', ${child}, 1, 1, '{"role":"assistant","parentID":"msg_utf8_input"}')`)
        yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES ('prt_utf8_result', 'msg_utf8_result', ${child}, 1, 1, ${JSON.stringify({ type: "text", text: "界".repeat(1000) })})`)
        const view = yield* SessionTaskView.read(
          { db, filename: ":memory:" },
          {
            parentSessionID: root,
            childSessionID: child,
            includeResults: true,
          },
        )
        expect(view.result?.truncated).toBe(true)
        expect(Buffer.byteLength(view.result?.summary ?? "", "utf8")).toBeLessThanOrEqual(2048)
        expect(view.result?.summary).not.toContain("�")
        expect(view.result?.summary).toBe("界".repeat(682))
      }),
    )
  })

  test("child summary follows active A while B and C queue and keeps result references on their invocations", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const child = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "queued-child",
            directory: "/project/private",
            title: "queued-child",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const entries = ["a", "b", "c"]
        for (const [index, suffix] of entries.entries()) {
          yield* db
            .insert(SessionTaskTable)
            .values({
              input_id: `msg_summary_${suffix}`,
              root_session_id: root,
              parent_session_id: root,
              parent_message_id: `msg_parent_${suffix}`,
              call_id: `call-${suffix}`,
              prompt_digest: `digest-${suffix}`,
              child_session_id: child,
              description: suffix,
              agent_id: "build",
              location_revision: 0,
              state: index === 0 ? "active" : "queued",
              backend: "legacy",
              time_created: index + 1,
            })
            .run()
            .pipe(Effect.orDie)
        }
        const database = { db, filename: ":memory:" }
        const first = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(first.target.invocation?.call_id).toBe("call-a")
        expect(first.active_invocation?.call_id).toBe("call-a")
        expect(first.queued_count).toBe(2)
        expect(first.result).toBeUndefined()
        yield* db.run(sql`UPDATE session_task SET state = 'settled', outcome = 'completed',
          result_message_id = 'msg_result_a' WHERE input_id = 'msg_summary_a'`)
        const pending = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(pending.target.invocation?.call_id).toBe("call-b")
        expect(pending.phase).toBe("queued")
        expect(pending.queued_count).toBe(2)
        expect(pending.result).toBeUndefined()
        yield* db.run(sql`UPDATE session_task SET state = 'active' WHERE input_id = 'msg_summary_b'`)
        const second = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(second.target.invocation?.call_id).toBe("call-b")
        expect(second.queued_count).toBe(1)
        expect(second.result).toBeUndefined()
        const prior = yield* SessionTaskView.read(database, {
          parentSessionID: root,
          childSessionID: child,
          invocation: { parent_session_id: root, parent_message_id: "msg_parent_a", call_id: "call-a" },
        })
        expect(prior.result?.message_id).toBe("msg_result_a")
        yield* db.run(sql`UPDATE session_task SET state = 'settled', outcome = 'completed',
          result_message_id = 'msg_result_b' WHERE input_id = 'msg_summary_b'`)
        yield* db.run(sql`UPDATE session_task SET state = 'active' WHERE input_id = 'msg_summary_c'`)
        const third = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(third.target.invocation?.call_id).toBe("call-c")
        expect(third.result).toBeUndefined()
        const b = yield* SessionTaskView.read(database, {
          parentSessionID: root,
          childSessionID: child,
          invocation: { parent_session_id: root, parent_message_id: "msg_parent_b", call_id: "call-b" },
        })
        expect(b.result?.message_id).toBe("msg_result_b")
        yield* db.run(sql`UPDATE session_task SET state = 'settled', outcome = 'completed',
          result_message_id = 'msg_result_c' WHERE input_id = 'msg_summary_c'`)
        const completed = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
        expect(completed.target.invocation?.call_id).toBe("call-c")
        expect(completed.result?.message_id).toBe("msg_result_c")
      }),
    )
  })

  eventIt.effect("keeps archived invocation progress separate from a later run on the same child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const events = yield* EventV2.Service
      const root = SessionSchema.ID.create()
      const child = SessionSchema.ID.create()
      const info = {
        id: root,
        slug: "progress-root",
        projectID: Project.ID.global,
        directory: "/project",
        title: "root",
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      const first = {
        inputID: "msg_progress_a",
        rootSessionID: root,
        parentSessionID: root,
        parentMessageID: "msg_parent_progress_a",
        callID: "call-progress-a",
        promptDigest: "digest-a",
        childSessionID: child,
        description: "first run",
        agentID: "build",
        locationRevision: 0,
        backend: "legacy" as const,
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: child, info: { ...info, id: child, parentID: root, slug: "progress-child" }, task: first },
        { commit: () => SessionTask.validate(db, first.inputID) },
      )
      const started = yield* SessionTask.promote(db, events, { inputID: first.inputID, childSessionID: child })
      const second = {
        ...first,
        inputID: "msg_progress_b",
        parentMessageID: "msg_parent_progress_b",
        callID: "call-progress-b",
        promptDigest: "digest-b",
        description: "second run",
        backend: "v2" as const,
      }
      yield* events.publish(SessionTaskEvent.Admitted, {
        sessionID: child,
        admission: second,
        timestamp: Date.now(),
      })
      const queued = yield* SessionTask.find(db, second.inputID)
      expect(queued?.state).toBe("queued")
      yield* Effect.promise(() => Bun.sleep(5))
      const firstProgress = Math.max(Date.now(), started.time_started! + 1, queued!.time_created + 1)
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_child_progress_a', ${child}, ${firstProgress}, ${firstProgress}, '{"role":"assistant","parentID":"msg_progress_a"}')`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_child_progress_a', 'msg_child_progress_a', ${child}, ${firstProgress}, ${firstProgress}, '{"type":"text","text":"A"}')`)
      yield* SessionTask.archiveUnknown(database, events, {
        inputID: first.inputID,
        childSessionID: child,
        operationID: "archive-progress-a",
        actor: { kind: "user", id: "user-test" },
      })
      yield* Effect.promise(() => Bun.sleep(5))
      const sameMillis = Math.max(Date.now() + 1, firstProgress + 1)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_child_progress_a_boundary', 'msg_child_progress_a', ${child}, ${sameMillis}, ${sameMillis + 2}, '{"type":"text","text":"A late"}')`)
      yield* events.publish(SessionTaskEvent.Promoted, {
        sessionID: child,
        inputID: second.inputID,
        timestamp: sameMillis,
      })
      const running = yield* SessionTask.find(db, second.inputID)
      expect(running?.state).toBe("active")
      const secondProgress = sameMillis + 1
      expect(firstProgress).toBeGreaterThan(queued!.time_created)
      expect(running!.time_started).toBe(sameMillis)
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_child_progress_b', ${child}, ${sameMillis}, ${sameMillis}, '{"role":"assistant","parentID":"msg_progress_b"}')`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_child_progress_b', 'msg_child_progress_b', ${child}, ${sameMillis}, ${secondProgress}, '{"type":"text","text":"B"}')`)
      const old = yield* SessionTaskView.read(database, {
        parentSessionID: root,
        childSessionID: child,
        invocation: {
          parent_session_id: root,
          parent_message_id: first.parentMessageID,
          call_id: first.callID,
        },
      })
      const current = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
      expect(old.abandoned_unknown).toBe(true)
      expect(old.last_progress_at).toBe(sameMillis + 2)
      expect(current.target.invocation?.call_id).toBe(second.callID)
      expect(current.last_progress_at).toBe(secondProgress)
    }),
  )

  test("atomically rejects the ninth root invocation without leaving an empty child", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const children = Array.from({ length: 9 }, () => SessionSchema.ID.create())
        const attempts = yield* Effect.forEach(
          children,
          (child, index) =>
            SessionTask.withOwner(child)(
              db.transaction(
                () =>
                  Effect.gen(function* () {
                    yield* db
                      .insert(SessionTable)
                      .values({
                        id: child,
                        project_id: Project.ID.global,
                        parent_id: root,
                        slug: String(index),
                        directory: "/project",
                        title: String(index),
                        version: "test",
                      })
                      .run()
                      .pipe(Effect.orDie)
                    return yield* SessionTask.admit(db, {
                      inputID: `msg_task_${index}`,
                      rootSessionID: root,
                      parentSessionID: root,
                      parentMessageID: `msg_parent_${index}`,
                      callID: `call-${index}`,
                      promptDigest: "prompt",
                      childSessionID: child,
                      description: "task",
                      agentID: "build",
                      locationRevision: 0,
                      backend: "legacy",
                    })
                  }),
                { behavior: "immediate" },
              ),
            ).pipe(Effect.exit),
          { concurrency: "unbounded" },
        )
        expect(attempts.filter(Exit.isSuccess)).toHaveLength(8)
        expect(attempts.filter(Exit.isFailure)).toHaveLength(1)
        const stored = yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie)
        expect(stored).toHaveLength(8)
        const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
        expect(sessions).toHaveLength(9)
        expect(children.filter((child) => !sessions.some((session) => session.id === child))).toHaveLength(1)
      }),
    )
  })

  test("bounds pending inputs per child and per root under concurrent admission", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const children = Array.from({ length: 5 }, () => SessionSchema.ID.create())
        yield* Effect.forEach(children, (child, index) =>
          db
            .insert(SessionTable)
            .values({
              id: child,
              project_id: Project.ID.global,
              parent_id: root,
              slug: `child-${index}`,
              directory: "/project",
              title: "child",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie),
        )
        const admit = (child: SessionSchema.ID, index: number) =>
          SessionTask.withOwner(child)(
            db.transaction(
              () =>
                SessionTask.admit(db, {
                  inputID: `msg_pending_${index}`,
                  rootSessionID: root,
                  parentSessionID: root,
                  parentMessageID: `msg_parent_pending_${index}`,
                  callID: `call-pending-${index}`,
                  promptDigest: "prompt",
                  childSessionID: child,
                  description: "task",
                  agentID: "build",
                  locationRevision: 0,
                  backend: "legacy",
                  liveLegacyOwner: true,
                }),
              { behavior: "immediate" },
            ),
          )
        yield* Effect.forEach(children, (child, index) => admit(child, index))
        const pending = yield* Effect.forEach(
          Array.from({ length: 65 }, (_, index) => index),
          (index) => admit(children[index % children.length]!, index + 5).pipe(Effect.exit),
          { concurrency: "unbounded" },
        )
        expect(pending.filter(Exit.isSuccess)).toHaveLength(64)
        expect(pending.filter(Exit.isFailure)).toHaveLength(1)
        expect((yield* db.select().from(SessionTaskTable).all()).length).toBe(69)
      }),
    )
  })

  test("rejects the seventeenth pending input for one child", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const child = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child",
            directory: "/project",
            title: "child",
            version: "test",
          })
          .run()
        const admit = (index: number) =>
          SessionTask.withOwner(child)(
            db.transaction(
              () =>
                SessionTask.admit(db, {
                  inputID: `msg_child_${index}`,
                  rootSessionID: root,
                  parentSessionID: root,
                  parentMessageID: `msg_parent_child_${index}`,
                  callID: `call-child-${index}`,
                  promptDigest: "prompt",
                  childSessionID: child,
                  description: "task",
                  agentID: "build",
                  locationRevision: 0,
                  backend: "legacy",
                  liveLegacyOwner: true,
                }),
              { behavior: "immediate" },
            ),
          )
        yield* admit(0)
        const attempts = yield* Effect.forEach(
          Array.from({ length: 17 }, (_, index) => index + 1),
          (index) => admit(index).pipe(Effect.exit),
          { concurrency: "unbounded" },
        )
        expect(attempts.filter(Exit.isSuccess)).toHaveLength(16)
        expect(attempts.filter(Exit.isFailure)).toHaveLength(1)
      }),
    )
  })

  test("keeps one child queue FIFO and settles the exact result reference", async () => {
    await run(
      Effect.gen(function* () {
        const { db, root } = yield* fixture
        const child = SessionSchema.ID.create()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child",
            directory: "/project",
            title: "child",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const admit = (index: number) =>
          db.transaction(
            () =>
              SessionTask.admit(db, {
                inputID: `msg_task_${index}`,
                rootSessionID: root,
                parentSessionID: root,
                parentMessageID: `msg_parent_${index}`,
                callID: `call-${index}`,
                promptDigest: `prompt-${index}`,
                childSessionID: child,
                description: "task",
                agentID: "build",
                locationRevision: 0,
                backend: "legacy",
                liveLegacyOwner: true,
              }),
            { behavior: "immediate" },
          )
        expect((yield* admit(0))?.state).toBe("admitted")
        expect((yield* admit(1))?.state).toBe("queued")
        expect((yield* admit(2))?.state).toBe("queued")
        const pendingView = yield* SessionTaskView.read(
          { db, filename: ":memory:" },
          {
            parentSessionID: root,
            childSessionID: child,
            invocation: { parent_session_id: root, parent_message_id: "msg_parent_1", call_id: "call-1" },
          },
        )
        expect(pendingView.eligibility).toBe("frozen")
        expect(
          Exit.isFailure(
            yield* SessionTask.projectPromoted(db, {
              inputID: "msg_task_2",
              childSessionID: child,
              timestamp: Date.now(),
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* SessionTask.projectPromoted(db, {
          inputID: "msg_task_0",
          childSessionID: child,
          timestamp: Date.now(),
        })
        yield* SessionTask.projectSettled(db, {
          inputID: "msg_task_0",
          childSessionID: child,
          outcome: "completed",
          resultMessageID: "msg_result_0",
          timestamp: Date.now(),
        })
        yield* SessionTask.projectPromoted(db, {
          inputID: "msg_task_1",
          childSessionID: child,
          timestamp: Date.now(),
        })
        expect((yield* SessionTask.find(db, "msg_task_1"))?.state).toBe("active")
        expect((yield* SessionTask.find(db, "msg_task_0"))?.result_message_id).toBe("msg_result_0")
        expect((yield* SessionTask.find(db, "msg_task_2"))?.state).toBe("queued")
        expect(
          (yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.root_session_id, root)).all()).length,
        ).toBe(3)
      }),
    )
  })
})

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Deferred, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable, SessionTaskTable } from "@opencode-ai/core/session/sql"
import { SessionTaskView } from "@opencode-ai/core/session/task-view"
import { SessionTask } from "@opencode-ai/core/session/task"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTaskOwner } from "@opencode-ai/core/session/task-owner"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionTask local owner lease", () => {
  test("excludes another holder and releases after normal completion", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "tasks.sqlite")
    const first = await SessionTaskOwner.acquireLocalLease(filename, "child-lock")
    try {
      expect(await SessionTaskOwner.processIdentity(first.holderPID)).toBe(first.holderStart)
      await expect(SessionTaskOwner.acquireLocalLease(filename, "child-lock")).rejects.toThrow()
    } finally {
      await first.close()
    }
    const second = await SessionTaskOwner.acquireLocalLease(filename, "child-lock")
    await second.close()
  })

  test("detects a holder that exits unexpectedly", async () => {
    await using temp = await tmpdir()
    const lease = await SessionTaskOwner.acquireLocalLease(path.join(temp.path, "tasks.sqlite"), "child-lost")
    process.kill(lease.holderPID, "SIGKILL")
    expect(await lease.exited).not.toBe(0)
    await expect(lease.close()).rejects.toBeInstanceOf(SessionTaskOwner.LeaseLost)
  })

  test("two controller processes cannot overlap, even with stale process identity", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "tasks.sqlite")
    const script = `
      import { SessionTaskOwner } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/task-owner.ts"))};
      const lease = await SessionTaskOwner.acquireLocalLease(${JSON.stringify(filename)}, "child-two-process");
      console.log("READY " + process.pid);
      await Bun.sleep(1500);
      await lease.close();
    `
    const controller = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = controller.stdout.getReader()
      const first = await reader.read()
      reader.releaseLock()
      expect(first.done).toBe(false)
      const line = new TextDecoder().decode(first.value)
      expect(line).toContain("READY ")
      const pid = Number(line.trim().split(" ").at(-1))
      expect(await SessionTaskOwner.priorProcessExited(pid, "stale-process-start")).toBe(true)
      await expect(SessionTaskOwner.acquireLocalLease(filename, "child-two-process")).rejects.toThrow()
      expect(await controller.exited).toBe(0)
      const lease = await SessionTaskOwner.acquireLocalLease(filename, "child-two-process")
      await lease.close()
    } finally {
      if (controller.exitCode === null) controller.kill()
      await controller.exited
    }
  })

  test("propagates unexpected holder exit to running work", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "tasks.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const root = SessionSchema.ID.create()
        const child = SessionSchema.ID.create()
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: root,
            project_id: Project.ID.global,
            slug: "root",
            directory: temp.path,
            title: "root",
            version: "test",
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child",
            directory: temp.path,
            title: "child",
            version: "test",
          })
          .run()
        yield* db
          .insert(SessionTaskTable)
          .values({
            input_id: "msg_owner",
            root_session_id: root,
            parent_session_id: root,
            parent_message_id: "msg_parent",
            call_id: "call-owner",
            prompt_digest: "digest",
            child_session_id: child,
            description: "task",
            agent_id: "build",
            location_revision: 0,
            state: "active",
            backend: "legacy",
            time_created: Date.now(),
            time_started: Date.now(),
          })
          .run()
        const ready = yield* Deferred.make<void>()
        let lost = false
        const fiber = yield* SessionTaskOwner.withLease(
          yield* Database.Service,
          {
            childSessionID: child,
            inputID: "msg_owner",
            onLost: () => {
              lost = true
            },
          },
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const owner = yield* Effect.promise(() => SessionTaskOwner.observe(filename, child))
        expect(owner?.holder_pid).toBeNumber()
        if (!owner) throw new Error("missing local holder")
        const first = yield* SessionTaskView.read(yield* Database.Service, {
          parentSessionID: root,
          childSessionID: child,
        })
        expect(first.runtime).toBe("observed")
        expect(first.runtime_observation?.owner_generation).toBe(owner.owner_generation)
        expect(first.read_at).toBeGreaterThanOrEqual(first.runtime_observation?.observed_at ?? 0)
        yield* Effect.sleep("2 millis")
        const second = yield* SessionTaskView.read(yield* Database.Service, {
          parentSessionID: root,
          childSessionID: child,
        })
        expect(second.runtime_observation?.observed_at).toBeGreaterThan(first.runtime_observation?.observed_at ?? 0)
        expect(second.read_at).toBeGreaterThanOrEqual(second.runtime_observation?.observed_at ?? 0)
        expect(second.last_progress_at).toBe(first.last_progress_at)
        process.kill(owner.holder_pid, "SIGKILL")
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(lost).toBe(true)
        const after = yield* SessionTaskView.read(yield* Database.Service, {
          parentSessionID: root,
          childSessionID: child,
        })
        expect(after.runtime).toBe("unknown")
        expect(after.runtime_observation).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("a restarted controller reads the old invocation as unknown without replay", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "tasks.sqlite")
    const root = SessionSchema.ID.create()
    const child = SessionSchema.ID.create()
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: root,
            project_id: Project.ID.global,
            slug: "root",
            directory: temp.path,
            title: "root",
            version: "test",
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: Project.ID.global,
            parent_id: root,
            slug: "child",
            directory: temp.path,
            title: "child",
            version: "test",
          })
          .run()
        yield* db
          .insert(SessionTaskTable)
          .values({
            input_id: "msg_crash",
            root_session_id: root,
            parent_session_id: root,
            parent_message_id: "msg_parent_crash",
            call_id: "call-crash",
            prompt_digest: "digest",
            child_session_id: child,
            description: "task",
            agent_id: "build",
            location_revision: 0,
            state: "active",
            backend: "legacy",
            time_created: Date.now(),
            time_started: Date.now(),
          })
          .run()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    const script = `
      import { Database } from ${JSON.stringify(path.join(import.meta.dir, "../src/database/database.ts"))};
      import { SessionTaskOwner } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/task-owner.ts"))};
      import { Effect } from "effect";
      await Effect.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service;
        yield* SessionTaskOwner.withLease(database, { childSessionID: ${JSON.stringify(child)}, inputID: "msg_crash" },
          Effect.sync(() => console.log("READY")).pipe(Effect.andThen(Effect.never)));
      }).pipe(Effect.provide(Database.layerFromPath(${JSON.stringify(filename)})), Effect.scoped));
    `
    const controller = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const reader = controller.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value)).toContain("READY")
      controller.kill("SIGKILL")
      expect(await controller.exited).not.toBe(0)
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const row = yield* database.db.select().from(SessionTaskTable).get()
          expect(row?.owner_pid).toBe(controller.pid)
          expect(row?.owner_start).toBeTruthy()
          if (!row?.owner_start) throw new Error("missing old owner start")
          expect(
            yield* Effect.promise(() => SessionTaskOwner.priorProcessExited(controller.pid, row.owner_start!)),
          ).toBe(true)
          const stale = JSON.stringify({
            type: "tool",
            callID: "call-stale-tool",
            tool: "shell",
            state: {
              status: "running",
              input: { secret: "must-not-leak" },
              time: { start: Date.now() },
            },
          })
          yield* database.db.run(
            sql`insert into message (id, session_id, time_created, time_updated, data) values ('msg_stale_assistant', ${child}, ${Date.now()}, ${Date.now()}, '{}')`,
          )
          yield* database.db.run(
            sql`insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_stale_tool', 'msg_stale_assistant', ${child}, ${Date.now()}, ${Date.now()}, ${stale})`,
          )
          const view = yield* SessionTaskView.read(database, { parentSessionID: root, childSessionID: child })
          expect(view.lifecycle).toBe("active")
          expect(view.runtime).toBe("unknown")
          expect(view.outcome).toBeUndefined()
          expect(view.active_tools).toHaveLength(0)
          expect(view.phase).toBe("unknown")
          expect(JSON.stringify(view)).not.toContain("must-not-leak")
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      const exclusive = await SessionTaskOwner.acquireLocalLease(filename, child)
      await exclusive.close()
    } finally {
      if (controller.exitCode === null) controller.kill()
      await controller.exited
    }
  })

  test("a second controller cannot archive unknown while the first still holds the child", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "tasks.sqlite")
    const root = SessionSchema.ID.create()
    const child = SessionSchema.ID.create()
    const script = `
      import { SessionTaskOwner } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/task-owner.ts"))};
      const lease = await SessionTaskOwner.acquireLocalLease(${JSON.stringify(filename)}, ${JSON.stringify(child)});
      console.log("READY");
      await Bun.sleep(5000);
      await lease.close();
    `
    const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(filename)],
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const info = {
          id: root,
          slug: "root",
          projectID: Project.ID.global,
          directory: temp.path,
          title: "root",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        }
        const admission = {
          inputID: "msg_archive_lock",
          rootSessionID: root,
          parentSessionID: root,
          parentMessageID: "msg_parent_archive",
          callID: "call-archive",
          promptDigest: "digest",
          childSessionID: child,
          description: "task",
          agentID: "build",
          locationRevision: 0,
          backend: "legacy" as const,
        }
        yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
        yield* events.publish(
          SessionV1.Event.Created,
          {
            sessionID: child,
            info: { ...info, id: child, parentID: root, slug: "child" },
            task: admission,
          },
          { commit: () => SessionTask.validate(database.db, admission.inputID) },
        )
        yield* SessionTask.promote(database.db, events, { inputID: admission.inputID, childSessionID: child })
        const controller = Bun.spawn([process.execPath, "-e", script], {
          cwd: import.meta.dir,
          stdout: "pipe",
          stderr: "pipe",
        })
        try {
          const reader = controller.stdout.getReader()
          const ready = yield* Effect.promise(() => reader.read())
          reader.releaseLock()
          expect(new TextDecoder().decode(ready.value)).toContain("READY")
          const input = {
            inputID: admission.inputID,
            childSessionID: child,
            operationID: "archive-concurrent",
            actor: { kind: "user" as const, id: "user-test" },
          }
          const denied = yield* SessionTask.archiveUnknown(database, events, input).pipe(Effect.exit)
          expect(Exit.isFailure(denied)).toBe(true)
          expect((yield* SessionTask.find(database.db, admission.inputID))?.abandoned_unknown).toBe(false)
          controller.kill("SIGKILL")
          yield* Effect.promise(() => controller.exited)
          const archived = yield* SessionTask.archiveUnknown(database, events, input)
          expect(archived?.abandoned_unknown).toBe(true)
          expect(archived?.outcome).toBeNull()
        } finally {
          if (controller.exitCode === null) controller.kill()
          yield* Effect.promise(() => controller.exited)
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})

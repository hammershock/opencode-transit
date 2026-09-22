import { $ } from "bun"
import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRevert } from "@opencode-ai/core/session/revert"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionV2.node, SessionStore.node, SessionProjector.node, Database.node, EventV2.node]),
    [[SessionExecution.node, SessionExecution.noopLayer]],
  ),
)
const sessionID = SessionV2.ID.make("ses_revert_mixed")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
const session = Effect.gen(function* () {
  const store = yield* SessionStore.Service
  const current = yield* store.get(sessionID)
  if (!current) return yield* Effect.die("missing test session")
  return current
})
const create = (directory = process.cwd()) =>
  EventV2.Service.use((events) =>
    events.publish(SessionV1.Event.Created, {
      sessionID,
      info: {
        id: sessionID,
        projectID: Project.ID.global,
        directory,
        slug: "revert",
        title: "revert",
        version: "test",
        time: { created: 0, updated: 0 },
      },
    }),
  )
const legacy = (id: string, time: number) =>
  EventV2.Service.use((events) =>
    events.publish(SessionV1.Event.MessageUpdated, {
      sessionID,
      info: {
        id: SessionV1.MessageID.make(id),
        sessionID,
        role: "user",
        agent: "build",
        model,
        time: { created: time },
      },
    }),
  )
const canonical = (id: string, time: number) =>
  EventV2.Service.use((events) =>
    events.publish(SessionEvent.Prompted, {
      sessionID,
      messageID: SessionMessage.ID.make(id),
      timestamp: DateTime.makeUnsafe(time),
      prompt: { text: id },
      delivery: "steer",
    }),
  )
const ids = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    legacy: (yield* db.select().from(MessageTable).orderBy(asc(MessageTable.time_created)).all()).map((row) =>
      String(row.id),
    ),
    canonical: (yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.seq)).all()).map((row) =>
      String(row.id),
    ),
  }
})

describe("mixed session revert", () => {
  for (const boundary of ["msg_legacy", "msg_skill"]) {
    it.effect(`commits and replays the combined suffix from ${boundary}`, () =>
      Effect.gen(function* () {
        yield* create()
        yield* legacy("msg_keep", 1)
        yield* legacy("msg_legacy", 2)
        yield* canonical("msg_skill", 3)
        yield* legacy("msg_later", 4)
        yield* canonical("msg_last", 5)
        const api = yield* SessionV2.Service
        yield* api.revert.stage({ sessionID, messageID: SessionMessage.ID.make(boundary), files: false })
        yield* api.revert.commit(sessionID)
        // A stale caller may retry commit; it must not submit a second deletion event.
        yield* api.revert.commit(sessionID)
        const expected = {
          legacy: boundary === "msg_legacy" ? ["msg_keep"] : ["msg_keep", "msg_legacy"],
          canonical: [],
        }
        expect(yield* ids).toEqual(expected)
        expect((yield* session).revert).toBeUndefined()

        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const journal = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
        yield* events.remove(sessionID)
        yield* events.replayAll(journal.map((row) => ({ ...row, aggregateID: row.aggregate_id })))
        expect(yield* ids).toEqual(expected)
        expect((yield* session).revert).toBeUndefined()
      }),
    )
  }

  it.effect("admits a replacement after a persisted legacy undo", () =>
    Effect.gen(function* () {
      yield* create()
      yield* legacy("msg_before", 1)
      yield* legacy("msg_undo", 2)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.RevertUpdated, {
        sessionID,
        revert: { messageID: SessionV1.MessageID.make("msg_undo") },
      })
      const api = yield* SessionV2.Service
      const admitted = yield* api.prompt({ sessionID, prompt: { text: "replacement" }, resume: false })
      expect(admitted.prompt.text).toBe("replacement")
      expect((yield* ids).legacy).toEqual(["msg_before"])
      expect((yield* session).revert).toBeUndefined()
    }),
  )

  it.effect("rejects a missing boundary without deleting history", () =>
    Effect.gen(function* () {
      yield* create()
      yield* legacy("msg_keep", 1)
      const api = yield* SessionV2.Service
      const result = yield* api.revert
        .stage({ sessionID, messageID: SessionMessage.ID.make("msg_missing") })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* ids).toEqual({ legacy: ["msg_keep"], canonical: [] })
      expect((yield* session).revert).toBeUndefined()
    }),
  )

  it.effect("preserves a partial legacy boundary when committing through the current API", () =>
    Effect.gen(function* () {
      yield* create()
      yield* legacy("msg_partial", 1)
      const events = yield* EventV2.Service
      for (const id of ["prt_before", "prt_cut", "prt_later"]) {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          time: 1,
          part: {
            id: SessionV1.PartID.make(id),
            messageID: SessionV1.MessageID.make("msg_partial"),
            sessionID,
            type: "text",
            text: id,
          },
        })
      }
      yield* canonical("msg_later", 2)
      yield* events.publish(SessionV1.Event.RevertUpdated, {
        sessionID,
        revert: { messageID: SessionV1.MessageID.make("msg_partial"), partID: SessionV1.PartID.make("prt_cut") },
      })
      const api = yield* SessionV2.Service
      yield* api.revert.commit(sessionID)
      expect(yield* ids).toEqual({ legacy: ["msg_partial"], canonical: [] })
      const { db } = yield* Database.Service
      expect((yield* db.select().from(PartTable).all()).map((part) => String(part.id))).toEqual(["prt_before"])
    }),
  )

  it.effect("keeps an earlier turn's late assistant when undoing a queued user turn", () =>
    Effect.gen(function* () {
      yield* create()
      yield* legacy("msg_before", 1)
      yield* canonical("msg_queued", 2)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: SessionV1.MessageID.make("msg_late_assistant"),
          sessionID,
          role: "assistant",
          parentID: SessionV1.MessageID.make("msg_before"),
          agent: "build",
          mode: "build",
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: process.cwd(), root: process.cwd() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 3, completed: 4 },
        },
      })
      const api = yield* SessionV2.Service
      yield* api.revert.stage({ sessionID, messageID: SessionMessage.ID.make("msg_queued"), files: false })
      yield* api.revert.commit(sessionID)
      expect(yield* ids).toEqual({ legacy: ["msg_before", "msg_late_assistant"], canonical: [] })
    }),
  )

  it.live(
    "round-trips mixed file patches selectively and recovers a partial restore failure",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const directory = path.join(tmp.path, "project")
            yield* Effect.promise(async () => {
              await $`mkdir -p ${directory}`.quiet()
              await Bun.write(path.join(directory, "edited.txt"), "initial\n")
              await Bun.write(path.join(directory, "deleted.txt"), "keep\n")
              await Bun.write(path.join(directory, "outside.txt"), "outside\n")
              await $`git init`.cwd(directory).quiet()
              await $`git -c user.email=test@example.com -c user.name=Test -c commit.gpgsign=false add .`
                .cwd(directory)
                .quiet()
              await $`git -c user.email=test@example.com -c user.name=Test -c commit.gpgsign=false commit -m initial`
                .cwd(directory)
                .quiet()
            })
            yield* create(directory)
            const layer = AppNodeBuilder.build(LayerNode.group([Snapshot.node, Location.node]), [
              [Location.node, Location.boundNode({ directory: AbsolutePath.make(directory) })],
              [
                Global.node,
                Global.layerWith({ data: path.join(tmp.path, "data"), config: path.join(tmp.path, "config") }),
              ],
            ])
            yield* Effect.gen(function* () {
              const snapshots = yield* Snapshot.Service
              const events = yield* EventV2.Service
              const first = yield* snapshots.capture()
              if (!first) return yield* Effect.die("snapshot unavailable")
              yield* legacy("msg_legacy", 1)
              yield* Effect.promise(() => Bun.write(path.join(directory, "edited.txt"), "legacy\n"))
              // Legacy persisted patches contain absolute target-side paths.
              yield* events.publish(SessionV1.Event.PartUpdated, {
                sessionID,
                time: 1,
                part: {
                  id: SessionV1.PartID.make("prt_patch"),
                  sessionID,
                  messageID: SessionV1.MessageID.make("msg_legacy"),
                  type: "patch",
                  hash: first,
                  files: [path.join(directory, "edited.txt")],
                },
              })
              const second = yield* snapshots.capture()
              if (!second) return yield* Effect.die("snapshot unavailable")
              yield* canonical("msg_skill", 2)
              yield* events.publish(SessionEvent.Step.Started, {
                sessionID,
                timestamp: DateTime.makeUnsafe(3),
                assistantMessageID: SessionMessage.ID.make("msg_assistant"),
                agent: "build",
                model: { providerID: model.providerID, id: model.modelID },
                snapshot: second,
              })
              yield* Effect.promise(async () => {
                await Bun.write(path.join(directory, "edited.txt"), "canonical\n")
                await Bun.write(path.join(directory, "added.txt"), "new\n")
                await Bun.file(path.join(directory, "deleted.txt")).delete()
              })
              const end = yield* snapshots.capture()
              yield* events.publish(SessionEvent.Step.Ended, {
                sessionID,
                timestamp: DateTime.makeUnsafe(4),
                assistantMessageID: SessionMessage.ID.make("msg_assistant"),
                finish: "stop",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                snapshot: end,
                files: [
                  RelativePath.make("edited.txt"),
                  RelativePath.make("added.txt"),
                  RelativePath.make("deleted.txt"),
                ],
              })
              yield* Effect.promise(() => Bun.write(path.join(directory, "outside.txt"), "external change\n"))
              const original = yield* session

              // An unavailable capture must not change files or stage a boundary.
              const unavailable = yield* SessionRevert.stage({
                session: original,
                messageID: SessionMessage.ID.make("msg_legacy"),
              }).pipe(
                Effect.provideService(Snapshot.Service, { ...snapshots, capture: () => Effect.succeed(undefined) }),
                Effect.exit,
              )
              expect(Exit.isFailure(unavailable)).toBe(true)
              expect((yield* session).revert).toBeUndefined()

              let failed = false
              const fault = yield* SessionRevert.stage({
                session: original,
                messageID: SessionMessage.ID.make("msg_legacy"),
              }).pipe(
                Effect.provideService(Snapshot.Service, {
                  ...snapshots,
                  restore: (input) =>
                    Effect.gen(function* () {
                      if (failed) return yield* snapshots.restore(input)
                      failed = true
                      expect((yield* session).revert?.snapshot).toBeDefined()
                      yield* snapshots.restore({ files: new Map(Array.from(input.files).slice(0, 1)) })
                      return yield* new Snapshot.Error({ operation: "restore", message: "injected partial failure" })
                    }),
                }),
                Effect.exit,
              )
              expect(Exit.isFailure(fault)).toBe(true)
              expect((yield* session).revert).toBeUndefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe(
                "canonical\n",
              )

              const stranded = yield* SessionRevert.stage({
                session: original,
                messageID: SessionMessage.ID.make("msg_legacy"),
              }).pipe(
                Effect.provideService(Snapshot.Service, {
                  ...snapshots,
                  restore: (input) =>
                    Effect.gen(function* () {
                      yield* snapshots.restore({ files: new Map(Array.from(input.files).slice(0, 1)) })
                      return yield* new Snapshot.Error({ operation: "restore", message: "injected persistent failure" })
                    }),
                }),
                Effect.exit,
              )
              expect(Exit.isFailure(stranded)).toBe(true)
              expect((yield* session).revert?.snapshot).toBeDefined()
              yield* SessionRevert.clear(original)
              expect((yield* session).revert).toBeUndefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe(
                "canonical\n",
              )

              yield* SessionRevert.stage({ session: original, messageID: SessionMessage.ID.make("msg_skill") })
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe("legacy\n")
              yield* SessionRevert.stage({ session: original, messageID: SessionMessage.ID.make("msg_legacy") })
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe("initial\n")
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "added.txt")).exists())).toBe(false)
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "deleted.txt")).text())).toBe("keep\n")
              yield* SessionRevert.stage({ session: original, messageID: SessionMessage.ID.make("msg_skill") })
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe("legacy\n")
              yield* SessionRevert.clear(original)
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "edited.txt")).text())).toBe(
                "canonical\n",
              )
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "added.txt")).text())).toBe("new\n")
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "deleted.txt")).exists())).toBe(false)
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "outside.txt")).text())).toBe(
                "external change\n",
              )
              expect((yield* session).revert).toBeUndefined()
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    30_000,
  )
})

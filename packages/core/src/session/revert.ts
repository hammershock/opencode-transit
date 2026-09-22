export * as SessionRevert from "./revert"

import { asc, eq, inArray } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import path from "path"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { KeyedMutex } from "../effect/keyed-mutex"
import { RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { PartTable, SessionTable } from "./sql"
import { RevertHistory } from "./revert-history"
import { SessionV1 } from "../v1/session"

const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly partID?: string
}

const plan = Effect.fn("SessionRevert.plan")(function* (input: BoundaryInput) {
  const db = (yield* Database.Service).db
  const boundary = yield* RevertHistory.boundary(input.sessionID, input.messageID)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const ids = boundary.messages.flatMap((item) => (item.kind === "legacy" ? [item.row.id] : []))
  const parts = ids.length
    ? yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
    : []
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const item of boundary.messages) {
    if (item.kind === "legacy") {
      for (const part of parts.filter((part) => part.message_id === item.row.id)) {
        if (String(item.row.id) === input.messageID && input.partID && part.id < input.partID) continue
        if (part.data.type !== "patch") continue
        const patch = yield* Schema.decodeUnknownEffect(SessionV1.Part)({
          ...part.data,
          id: part.id,
          sessionID: part.session_id,
          messageID: part.message_id,
        }).pipe(Effect.orDie)
        if (patch.type !== "patch") continue
        const location = yield* Location.Service
        for (const absolute of patch.files) {
          const file = RelativePath.make(path.relative(location.project.directory, absolute).replaceAll("\\", "/"))
          if (!files.has(file)) files.set(file, Snapshot.ID.make(patch.hash))
        }
      }
      continue
    }
    if (item.row.type !== "assistant") continue
    const row = item.row
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})

export const stage = Effect.fn("SessionRevert.stage")(
  function* (input: {
    readonly session: SessionSchema.Info
    readonly messageID: SessionMessage.ID
    readonly files?: boolean
    readonly partID?: string
  }) {
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2.Service
    const next = yield* plan({ sessionID: input.session.id, messageID: input.messageID, partID: input.partID })
    const prior = yield* current(input.session.id)
    const priorFiles =
      prior?.files?.map((file) => file.path) ??
      (prior?.snapshot
        ? Array.from(
            (yield* plan({ sessionID: input.session.id, messageID: prior.messageID, partID: prior.partID })).keys(),
          )
        : [])
    const paths = input.files === false ? [] : Array.from(next.keys())
    // Snapshot capture/restore and per-file diffs traverse the (possibly remote)
    // filesystem, so only capture when the reverted boundary actually needs it:
    // restoring prior files, restoring this turn's files, or producing the diff.
    const original = prior?.snapshot
      ? Snapshot.ID.make(prior.snapshot)
      : priorFiles.length > 0 || paths.length > 0
        ? yield* snapshot.capture()
        : undefined
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of priorFiles) restore.set(file, original)
    }
    if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size && !original)
      return yield* new Snapshot.Error({
        operation: "capture",
        message: "Cannot undo files without a recovery snapshot",
      })
    // Build the diff before touching files. A failed preview cannot strand an unrecorded undo.
    const files = paths.length ? yield* snapshot.preview({ from: original, files: next }) : []
    const revert = {
      messageID: input.messageID,
      ...(input.partID ? { partID: input.partID } : {}),
      snapshot: original,
      diff: files
        .map((file) => file.patch)
        .join("")
        .trim(),
      files,
    } satisfies SessionSchema.Info["revert"]
    const recovery = restore.size ? (prior ? yield* snapshot.capture() : original) : undefined
    if (restore.size && !recovery)
      return yield* new Snapshot.Error({
        operation: "capture",
        message: "Cannot update undo without a recovery snapshot",
      })
    if (restore.size) {
      // Persist recovery before touching files, including paths restored while moving
      // a boundary forward. A process crash or failed rollback must still allow redo.
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: input.session.id,
        timestamp: yield* DateTime.now,
        revert: {
          ...revert,
          files: Array.from(
            restore.keys(),
            (path) =>
              files.find((file) => file.path === path) ?? {
                path,
                status: "modified" as const,
                additions: 0,
                deletions: 0,
                patch: "",
              },
          ),
        },
      })
    }
    yield* Effect.gen(function* () {
      if (restore.size) yield* snapshot.restore({ files: restore })
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: input.session.id,
        timestamp: yield* DateTime.now,
        revert,
      })
    }).pipe(
      Effect.onError(() =>
        recovery
          ? Effect.gen(function* () {
              yield* snapshot.restore({ files: new Map(Array.from(restore.keys(), (file) => [file, recovery])) })
              const timestamp = yield* DateTime.now
              if (prior) {
                yield* events.publish(SessionEvent.RevertEvent.Staged, {
                  sessionID: input.session.id,
                  timestamp,
                  revert: prior,
                })
                return
              }
              yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID: input.session.id, timestamp })
            }).pipe(
              Effect.catch((error) =>
                Effect.logError("Failed to roll back undo; recovery snapshot retained", { error }),
              ),
            )
          : Effect.void,
      ),
    )
    return revert
  },
  (effect, input) => locks.withLock(input.session.id)(Effect.uninterruptible(effect)),
)

export const clear = Effect.fn("SessionRevert.clear")(
  function* (session: SessionSchema.Info) {
    const revert = yield* current(session.id)
    if (!revert) return
    const snapshot = yield* Snapshot.Service
    const original = revert.snapshot ? Snapshot.ID.make(revert.snapshot) : undefined
    const paths =
      revert.files?.map((file) => file.path) ??
      (original
        ? Array.from(
            (yield* plan({ sessionID: session.id, messageID: revert.messageID, partID: revert.partID }).pipe(
              Effect.mapError(
                () =>
                  new Snapshot.Error({
                    operation: "restore",
                    message: "Cannot recover files: revert boundary is missing",
                  }),
              ),
            )).keys(),
          )
        : [])
    if (original && paths.length)
      yield* snapshot.restore({
        files: new Map(paths.map((file) => [file, original])),
      })
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
      timestamp: yield* DateTime.now,
    })
  },
  (effect, session) => locks.withLock(session.id)(Effect.uninterruptible(effect)),
)

export const commit = Effect.fn("SessionRevert.commit")(
  function* (session: SessionSchema.Info) {
    const revert = yield* current(session.id)
    if (!revert) return
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.RevertEvent.Committed, {
      sessionID: session.id,
      messageID: revert.messageID,
      timestamp: yield* DateTime.now,
    })
  },
  (effect, session) => locks.withLock(session.id)(Effect.uninterruptible(effect)),
)

const current = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const row = yield* db
    .select({ revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.revert
})

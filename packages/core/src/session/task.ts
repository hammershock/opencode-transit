export * as SessionTask from "./task"

import { and, asc, eq, inArray, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionSchema } from "./schema"
import { EventTable } from "../event/sql"
import { SessionV1 } from "../v1/session"
import { SessionTaskTable } from "./sql"

type DB = Database.Interface["db"]

export const ACTIVE_LIMIT = 8
export const CHILD_PENDING_LIMIT = 16
export const ROOT_PENDING_LIMIT = 64

/** The gate only orders local child operations; the immediate DB transaction arbitrates root quota. */
const owners = KeyedMutex.makeUnsafe<string>()
export const withOwner = owners.withLock

export class CapacityError extends Error {
  readonly code = "capacity_exceeded"
  constructor(
    readonly kind: "active" | "child_pending" | "root_pending",
    readonly used: number,
    readonly limit: number,
  ) {
    super(`capacity_exceeded: ${kind} quota ${used}/${limit}`)
  }
}

export class AdmissionConflict extends Error {
  readonly code = "task_admission_conflict"
  constructor() {
    super("task_admission_conflict: the invocation identity was reused with different input")
  }
}

export class OwnerUnknown extends Error {
  readonly code = "task_owner_unknown"
  constructor() {
    super("task_owner_unknown: the previous invocation has no confirmed live local owner")
  }
}

export class CapacityUnavailable extends Error {
  readonly code = "capacity_unavailable"
  constructor() {
    super("capacity_unavailable: the admitted input cannot start until a root slot is available")
  }
}

export type Admission = {
  inputID: string
  rootSessionID: SessionSchema.ID
  parentSessionID: SessionSchema.ID
  parentMessageID: string
  callID: string
  promptDigest: string
  childSessionID: SessionSchema.ID
  description: string
  agentID: string
  locationRevision: number
  backend: "legacy" | "v2"
  /** Legacy execution may queue only behind a currently observed local job. */
  liveLegacyOwner?: boolean
}

/**
 * Call only inside the child owner gate and an immediate DB transaction, such
 * as a durable Session event commit hook. Never hold this boundary over work.
 */
export const admit = Effect.fn("SessionTask.admit")(function* (
  db: DB,
  input: Admission,
  options?: { readonly validate?: boolean; readonly timestamp?: number },
) {
  if (options?.validate === false) {
    const deleted = yield* db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(
        and(
          inArray(EventTable.aggregate_id, [input.rootSessionID, input.parentSessionID, input.childSessionID]),
          eq(EventTable.type, EventV2.versionedType(SessionV1.Event.Deleted.type, 1)),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (deleted) return undefined
  }
  const existing = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(eq(SessionTaskTable.parent_message_id, input.parentMessageID), eq(SessionTaskTable.call_id, input.callID)),
    )
    .get()
    .pipe(Effect.orDie)
  if (existing) {
    if (
      existing.input_id !== input.inputID ||
      existing.root_session_id !== input.rootSessionID ||
      existing.parent_session_id !== input.parentSessionID ||
      existing.child_session_id !== input.childSessionID ||
      existing.prompt_digest !== input.promptDigest ||
      existing.description !== input.description ||
      existing.agent_id !== input.agentID ||
      existing.location_revision !== input.locationRevision ||
      existing.backend !== input.backend
    )
      return yield* Effect.die(new AdmissionConflict())
    return existing
  }

  const childRunning = yield* count(
    db,
    and(
      eq(SessionTaskTable.child_session_id, input.childSessionID),
      inArray(SessionTaskTable.state, ["admitted", "active"]),
    ),
  )
  if (options?.validate !== false && childRunning > 0 && input.backend === "legacy" && !input.liveLegacyOwner)
    return yield* Effect.die(new OwnerUnknown())
  const childPending = yield* count(
    db,
    and(eq(SessionTaskTable.child_session_id, input.childSessionID), eq(SessionTaskTable.state, "queued")),
  )
  const state = childRunning === 0 && childPending === 0 ? "admitted" : "queued"
  if (options?.validate !== false) {
    if (state === "admitted") {
      const active = yield* count(
        db,
        and(
          eq(SessionTaskTable.root_session_id, input.rootSessionID),
          inArray(SessionTaskTable.state, ["admitted", "active"]),
          eq(SessionTaskTable.abandoned_unknown, false),
        ),
      )
      if (active >= ACTIVE_LIMIT) return yield* Effect.die(new CapacityError("active", active, ACTIVE_LIMIT))
    }
    if (state === "queued") {
      if (childPending >= CHILD_PENDING_LIMIT)
        return yield* Effect.die(new CapacityError("child_pending", childPending, CHILD_PENDING_LIMIT))
      const rootPending = yield* count(
        db,
        and(eq(SessionTaskTable.root_session_id, input.rootSessionID), eq(SessionTaskTable.state, "queued")),
      )
      if (rootPending >= ROOT_PENDING_LIMIT)
        return yield* Effect.die(new CapacityError("root_pending", rootPending, ROOT_PENDING_LIMIT))
    }
  }
  yield* db
    .insert(SessionTaskTable)
    .values({
      input_id: input.inputID,
      root_session_id: input.rootSessionID,
      parent_session_id: input.parentSessionID,
      parent_message_id: input.parentMessageID,
      call_id: input.callID,
      prompt_digest: input.promptDigest,
      child_session_id: input.childSessionID,
      description: input.description,
      agent_id: input.agentID,
      location_revision: input.locationRevision,
      backend: input.backend,
      state,
      time_created: options?.timestamp ?? Date.now(),
    })
    .run()
    .pipe(Effect.orDie)
  return (yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.input_id, input.inputID))
    .get()
    .pipe(Effect.orDie))!
})

/** Called by the local event commit hook after projection; replay deliberately skips policy admission. */
export const validate = Effect.fn("SessionTask.validate")(function* (db: DB, inputID: string) {
  const row = yield* find(db, inputID)
  if (!row) return yield* Effect.die(new AdmissionConflict())
  if (row.state === "queued") {
    const child = yield* count(
      db,
      and(eq(SessionTaskTable.child_session_id, row.child_session_id), eq(SessionTaskTable.state, "queued")),
    )
    if (child > CHILD_PENDING_LIMIT)
      return yield* Effect.die(new CapacityError("child_pending", child - 1, CHILD_PENDING_LIMIT))
    const root = yield* count(
      db,
      and(eq(SessionTaskTable.root_session_id, row.root_session_id), eq(SessionTaskTable.state, "queued")),
    )
    if (root > ROOT_PENDING_LIMIT)
      return yield* Effect.die(new CapacityError("root_pending", root - 1, ROOT_PENDING_LIMIT))
    return
  }
  const active = yield* count(
    db,
    and(
      eq(SessionTaskTable.root_session_id, row.root_session_id),
      inArray(SessionTaskTable.state, ["admitted", "active"]),
      eq(SessionTaskTable.abandoned_unknown, false),
    ),
  )
  if (active > ACTIVE_LIMIT) return yield* Effect.die(new CapacityError("active", active - 1, ACTIVE_LIMIT))
})

export const admitExisting = Effect.fn("SessionTask.admitExisting")(function* (
  db: DB,
  events: EventV2.Interface,
  input: Admission,
  liveLegacyOwner: Effect.Effect<boolean>,
) {
  return yield* withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const running = yield* count(
        db,
        and(
          eq(SessionTaskTable.child_session_id, input.childSessionID),
          inArray(SessionTaskTable.state, ["admitted", "active"]),
        ),
      )
      if (running > 0 && input.backend === "legacy" && !(yield* liveLegacyOwner))
        return yield* Effect.die(new OwnerUnknown())
      yield* events.publish(
        SessionTaskEvent.Admitted,
        { sessionID: input.childSessionID, admission: input, timestamp: Date.now() },
        { commit: () => validate(db, input.inputID) },
      )
      return (yield* find(db, input.inputID))!
    }),
  )
})

export const find = Effect.fn("SessionTask.find")(function* (db: DB, inputID: string) {
  return yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.input_id, inputID))
    .get()
    .pipe(Effect.orDie)
})

export const findInvocation = Effect.fn("SessionTask.findInvocation")(function* (
  db: DB,
  input: { parentMessageID: string; callID: string },
) {
  return yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(eq(SessionTaskTable.parent_message_id, input.parentMessageID), eq(SessionTaskTable.call_id, input.callID)),
    )
    .get()
    .pipe(Effect.orDie)
})

export const promote = Effect.fn("SessionTask.promote")(function* (
  db: DB,
  events: EventV2.Interface,
  input: { inputID: string; childSessionID: string },
) {
  return yield* withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const current = yield* find(db, input.inputID)
      if (!current || current.child_session_id !== input.childSessionID || current.state === "settled")
        return yield* Effect.die(new AdmissionConflict())
      if (current.state === "active") return current
      yield* events.publish(
        SessionTaskEvent.Promoted,
        {
          sessionID: SessionSchema.ID.make(input.childSessionID),
          inputID: input.inputID,
          timestamp: Date.now(),
        },
        { commit: () => validatePromotion(db, input.inputID) },
      )
      return (yield* find(db, input.inputID))!
    }),
  )
})

export const projectPromoted = Effect.fn("SessionTask.projectPromoted")(function* (
  db: DB,
  input: { inputID: string; childSessionID: string; timestamp: number },
) {
  const current = yield* find(db, input.inputID)
  if (!current) return
  if (current.child_session_id !== input.childSessionID || current.state === "settled")
    return yield* Effect.die(new AdmissionConflict())
  if (current.state === "active") return
  if (current.state === "queued") {
    const head = yield* db
      .select({ id: SessionTaskTable.input_id })
      .from(SessionTaskTable)
      .where(and(eq(SessionTaskTable.child_session_id, input.childSessionID), eq(SessionTaskTable.state, "queued")))
      .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (head?.id !== input.inputID) return yield* Effect.die(new AdmissionConflict())
  }
  yield* db
    .update(SessionTaskTable)
    .set({ state: "active", time_started: input.timestamp })
    .where(eq(SessionTaskTable.input_id, input.inputID))
    .run()
    .pipe(Effect.orDie)
})

const validatePromotion = Effect.fn("SessionTask.validatePromotion")(function* (db: DB, inputID: string) {
  const row = yield* find(db, inputID)
  if (!row || row.state !== "active") return yield* Effect.die(new AdmissionConflict())
  const sameChild = yield* count(
    db,
    and(
      eq(SessionTaskTable.child_session_id, row.child_session_id),
      inArray(SessionTaskTable.state, ["admitted", "active"]),
      eq(SessionTaskTable.abandoned_unknown, false),
    ),
  )
  if (sameChild > 1) return yield* Effect.die(new OwnerUnknown())
  const used = yield* count(
    db,
    and(
      eq(SessionTaskTable.root_session_id, row.root_session_id),
      inArray(SessionTaskTable.state, ["admitted", "active"]),
      eq(SessionTaskTable.abandoned_unknown, false),
    ),
  )
  if (used > ACTIVE_LIMIT) return yield* Effect.die(new CapacityUnavailable())
})

export const settle = Effect.fn("SessionTask.settle")(function* (
  db: DB,
  events: EventV2.Interface,
  input: {
    inputID: string
    childSessionID: string
    outcome: "completed" | "failed" | "cancelled"
    resultMessageID?: string
  },
) {
  return yield* withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const previous = yield* find(db, input.inputID)
      if (!previous) return undefined
      if (previous.child_session_id !== input.childSessionID) return yield* Effect.die(new AdmissionConflict())
      if (previous.state === "settled") {
        if (previous.outcome !== input.outcome || previous.result_message_id !== (input.resultMessageID ?? null))
          return yield* Effect.die(new AdmissionConflict())
        return previous
      }
      yield* events.publish(SessionTaskEvent.Settled, {
        sessionID: SessionSchema.ID.make(input.childSessionID),
        inputID: input.inputID,
        outcome: input.outcome,
        ...(input.resultMessageID ? { resultMessageID: input.resultMessageID } : {}),
        timestamp: Date.now(),
      })
      return yield* find(db, input.inputID)
    }),
  )
})

export const projectSettled = Effect.fn("SessionTask.projectSettled")(function* (
  db: DB,
  input: {
    inputID: string
    childSessionID: string
    outcome: "completed" | "failed" | "cancelled"
    resultMessageID?: string
    timestamp: number
  },
) {
  const previous = yield* find(db, input.inputID)
  if (!previous) return
  if (previous.child_session_id !== input.childSessionID) return yield* Effect.die(new AdmissionConflict())
  if (previous.state === "settled") {
    if (previous.outcome !== input.outcome || previous.result_message_id !== (input.resultMessageID ?? null))
      return yield* Effect.die(new AdmissionConflict())
    return
  }
  yield* db
    .update(SessionTaskTable)
    .set({
      state: "settled",
      outcome: input.outcome,
      result_message_id: input.resultMessageID,
      time_settled: input.timestamp,
    })
    .where(eq(SessionTaskTable.input_id, input.inputID))
    .run()
    .pipe(Effect.orDie)
})

/** User-only management disposition: releases policy capacity but proves no terminal outcome or stop. */
export const archiveUnknown = Effect.fn("SessionTask.archiveUnknown")(function* (
  database: Database.Interface,
  events: EventV2.Interface,
  input: { inputID: string; childSessionID: string; operationID: string; actor: { kind: "user"; id: string } },
) {
  const db = database.db
  const snapshot = yield* find(db, input.inputID)
  if (!snapshot || snapshot.child_session_id !== input.childSessionID) return yield* Effect.die(new AdmissionConflict())
  if (snapshot.archive_operation_id) {
    if (snapshot.archive_operation_id !== input.operationID || snapshot.archive_actor_id !== input.actor.id)
      return yield* Effect.die(new AdmissionConflict())
    return snapshot
  }
  const commit = withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const other = yield* db
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.archive_operation_id, input.operationID))
        .get()
        .pipe(Effect.orDie)
      if (other && other.input_id !== input.inputID) return yield* Effect.die(new AdmissionConflict())
      const row = yield* find(db, input.inputID)
      if (!row || row.child_session_id !== input.childSessionID) return yield* Effect.die(new AdmissionConflict())
      if (row.owner_generation !== snapshot.owner_generation || row.state !== snapshot.state)
        return yield* Effect.die(new AdmissionConflict())
      if (row.archive_operation_id) {
        if (row.archive_operation_id !== input.operationID || row.archive_actor_id !== input.actor.id)
          return yield* Effect.die(new AdmissionConflict())
        return row
      }
      if (row.state === "settled" || row.state === "queued") return yield* Effect.die(new AdmissionConflict())
      yield* events.publish(SessionTaskEvent.ArchivedUnknown, {
        sessionID: SessionSchema.ID.make(input.childSessionID),
        inputID: input.inputID,
        operationID: input.operationID,
        actorID: input.actor.id,
        timestamp: Date.now(),
      })
      return yield* find(db, input.inputID)
    }),
  )
  if (!database.filename || database.filename === ":memory:") return yield* commit
  const { SessionTaskOwner } = yield* Effect.promise(() => import("./task-owner"))
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => SessionTaskOwner.acquireLocalLease(database.filename!, input.childSessionID),
      catch: (error) =>
        error instanceof SessionTaskOwner.OwnerUnavailable
          ? error
          : new SessionTaskOwner.OwnerUnavailable(String(error)),
    }),
    () => commit,
    (lease) => Effect.tryPromise(() => lease.close()).pipe(Effect.orDie),
  )
})

export const projectArchivedUnknown = Effect.fn("SessionTask.projectArchivedUnknown")(function* (
  db: DB,
  input: { inputID: string; childSessionID: string; operationID: string; actorID: string; timestamp: number },
) {
  const row = yield* find(db, input.inputID)
  if (!row) return
  if (row.child_session_id !== input.childSessionID) return yield* Effect.die(new AdmissionConflict())
  if (row.archive_operation_id) {
    if (row.archive_operation_id !== input.operationID || row.archive_actor_id !== input.actorID)
      return yield* Effect.die(new AdmissionConflict())
    return
  }
  if (row.state === "settled" || row.state === "queued") return yield* Effect.die(new AdmissionConflict())
  yield* db
    .update(SessionTaskTable)
    .set({
      abandoned_unknown: true,
      archive_operation_id: input.operationID,
      archive_actor_id: input.actorID,
      archive_time: input.timestamp,
    })
    .where(eq(SessionTaskTable.input_id, input.inputID))
    .run()
    .pipe(Effect.orDie)
})

function count(db: DB, where: SQL | undefined) {
  return db
    .select({ value: sql<number>`count(*)` })
    .from(SessionTaskTable)
    .where(where)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.value ?? 0),
    )
}

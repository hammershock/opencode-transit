export * as SessionTaskDelivery from "./task-delivery"

import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionExecution } from "./execution"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTaskOperationTable, SessionTaskSteerTable, SessionTaskTable } from "./sql"
import { SessionTask } from "./task"
import { SessionTaskOwner } from "./task-owner"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionTaskScheduler } from "./task-scheduler"
import { SessionLocationAccess } from "./location-access"
import { SessionTaskResult } from "./task-result"

export class UnknownOrForbidden extends Error {
  readonly code = "task_unknown_or_forbidden"
  constructor() {
    super("task_unknown_or_forbidden")
  }
}

export class NotRunning extends Error {
  readonly code = "task_not_running"
  constructor() {
    super("task_not_running")
  }
}

export class Unavailable extends Error {
  readonly code = "task_unavailable"
  constructor() {
    super("task_unavailable")
  }
}

export type Invocation = {
  parentSessionID: SessionSchema.ID
  parentMessageID: string
  callID: string
}

function digest(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

/** Admit a steer only while the exact Task invocation has a live local execution owner. */
export const send = Effect.fn("SessionTaskDelivery.send")(function* (input: {
  childSessionID: SessionSchema.ID
  invocationInputID: string
  invocation: Invocation
  operationID: string
  text: string
}) {
  const database = yield* Database.Service
  const db = database.db
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const promptDigest = digest(input.text)
  const existing = yield* db
    .select()
    .from(SessionTaskSteerTable)
    .where(eq(SessionTaskSteerTable.operation_id, input.operationID))
    .get()
    .pipe(Effect.orDie)
  if (existing) {
    if (existing.invocation_input_id !== input.invocationInputID || existing.prompt_digest !== promptDigest)
      return yield* Effect.fail(new SessionTask.AdmissionConflict())
    const task = yield* SessionTask.find(db, existing.invocation_input_id)
    if (
      !task ||
      task.child_session_id !== input.childSessionID ||
      task.parent_session_id !== input.invocation.parentSessionID ||
      task.parent_message_id !== input.invocation.parentMessageID ||
      task.call_id !== input.invocation.callID
    )
      return yield* Effect.fail(new UnknownOrForbidden())
    return { inputID: existing.input_id, state: existing.state, reason: existing.reason }
  }
  const target = yield* SessionTask.find(db, input.invocationInputID)
  if (
    !target ||
    target.child_session_id !== input.childSessionID ||
    target.parent_session_id !== input.invocation.parentSessionID ||
    target.parent_message_id !== input.invocation.parentMessageID ||
    target.call_id !== input.invocation.callID ||
    target.backend !== "v2"
  )
    return yield* Effect.fail(new UnknownOrForbidden())
  if (!database.filename || database.filename === ":memory:") return yield* Effect.fail(new Unavailable())
  const admitted = yield* SessionTask.withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const duplicate = yield* db
        .select()
        .from(SessionTaskSteerTable)
        .where(eq(SessionTaskSteerTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.orDie)
      if (duplicate) {
        if (duplicate.invocation_input_id !== input.invocationInputID || duplicate.prompt_digest !== promptDigest)
          return yield* Effect.fail(new SessionTask.AdmissionConflict())
        const target = yield* SessionTask.find(db, duplicate.invocation_input_id)
        if (
          !target ||
          target.child_session_id !== input.childSessionID ||
          target.parent_session_id !== input.invocation.parentSessionID ||
          target.parent_message_id !== input.invocation.parentMessageID ||
          target.call_id !== input.invocation.callID
        )
          return yield* Effect.fail(new UnknownOrForbidden())
        return { inputID: duplicate.input_id, state: duplicate.state, reason: duplicate.reason, fresh: false }
      }
      const task = yield* SessionTask.find(db, input.invocationInputID)
      if (
        !task ||
        task.child_session_id !== input.childSessionID ||
        task.parent_session_id !== input.invocation.parentSessionID ||
        task.parent_message_id !== input.invocation.parentMessageID ||
        task.call_id !== input.invocation.callID ||
        task.backend !== "v2"
      )
        return yield* Effect.fail(new UnknownOrForbidden())
      if (task.state !== "active" || task.abandoned_unknown) return yield* Effect.fail(new NotRunning())
      const observed = yield* Effect.promise(() => SessionTaskOwner.observe(database.filename!, input.childSessionID))
      if (!observed) return yield* Effect.fail(new Unavailable())
      if (task.owner_generation !== observed.owner_generation) return yield* Effect.fail(new Unavailable())
      const child = yield* db
        .select({ revision: SessionTable.location_revision })
        .from(SessionTable)
        .where(
          and(eq(SessionTable.id, input.childSessionID), eq(SessionTable.parent_id, input.invocation.parentSessionID)),
        )
        .get()
        .pipe(Effect.orDie)
      if (!child) return yield* Effect.fail(new UnknownOrForbidden())
      if (child.revision !== task.location_revision) return yield* Effect.fail(new Unavailable())
      const id = SessionMessage.ID.create()
      yield* SessionInput.admit(db, events, {
        id,
        sessionID: input.childSessionID,
        prompt: Prompt.make({ text: input.text }),
        delivery: "steer",
        task: {
          kind: "steer",
          invocationInputID: task.input_id,
          operationID: input.operationID,
          promptDigest,
        },
        commit: () =>
          Effect.gen(function* () {
            const current = yield* SessionTask.find(db, task.input_id)
            const location = yield* db
              .select({ revision: SessionTable.location_revision })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.childSessionID))
              .get()
              .pipe(Effect.orDie)
            if (
              !current ||
              current.state !== "active" ||
              current.abandoned_unknown ||
              current.owner_generation !== observed.owner_generation ||
              location?.revision !== task.location_revision
            )
              return yield* Effect.die(new NotRunning())
          }),
      })
      return { inputID: id, state: "admitted" as const, reason: null, fresh: true }
    }),
  )
  if (admitted.fresh) yield* execution.wake(input.childSessionID)
  return { inputID: admitted.inputID, state: admitted.state, reason: admitted.reason }
})

/** Record a distinct follow-up in the same child's durable queue. */
export const followup = Effect.fn("SessionTaskDelivery.followup")(function* (input: {
  childSessionID: SessionSchema.ID
  invocation: Invocation
  description: string
  agentID: string
  text: string
  background?: boolean
}) {
  const database = yield* Database.Service
  const db = database.db
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const prior = yield* SessionTask.findInvocation(db, input.invocation)
  const promptDigest = digest(input.text)
  if (prior) {
    if (
      prior.child_session_id !== input.childSessionID ||
      prior.parent_session_id !== input.invocation.parentSessionID ||
      prior.prompt_digest !== promptDigest ||
      prior.description !== input.description ||
      prior.agent_id !== input.agentID ||
      prior.backend !== "v2" ||
      prior.background !== (input.background ?? false)
    )
      return yield* Effect.fail(new SessionTask.AdmissionConflict())
    return { inputID: prior.input_id, state: prior.state }
  }
  const child = yield* db
    .select({ parentID: SessionTable.parent_id, revision: SessionTable.location_revision })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.childSessionID))
    .get()
    .pipe(Effect.orDie)
  if (!child || child.parentID !== input.invocation.parentSessionID) return yield* Effect.fail(new UnknownOrForbidden())
  const established = yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.child_session_id, input.childSessionID))
    .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!established || established.backend !== "v2") return yield* Effect.fail(new Unavailable())
  if (!database.filename || database.filename === ":memory:") return yield* Effect.fail(new Unavailable())
  const active = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, input.childSessionID),
        inArray(SessionTaskTable.state, ["admitted", "active"]),
        eq(SessionTaskTable.abandoned_unknown, false),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const observed = active
    ? yield* Effect.promise(() => SessionTaskOwner.observe(database.filename!, input.childSessionID))
    : undefined
  if (active && (!observed || observed.owner_generation !== active.owner_generation))
    return yield* Effect.fail(new Unavailable())
  const old = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(eq(SessionTaskTable.child_session_id, input.childSessionID), eq(SessionTaskTable.abandoned_unknown, true)),
    )
    .orderBy(asc(SessionTaskTable.input_id))
    .all()
    .pipe(Effect.orDie)
  if (
    old.length > 0 &&
    !(yield* Effect.forEach(old, (row) =>
      row.owner_pid && row.owner_start
        ? Effect.promise(() => SessionTaskOwner.priorProcessExited(row.owner_pid!, row.owner_start!))
        : Effect.succeed(false),
    )).every(Boolean)
  )
    return yield* Effect.fail(new Unavailable())
  const frozen = yield* db
    .select({ inputID: SessionTaskTable.input_id })
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, input.childSessionID),
        eq(SessionTaskTable.state, "queued"),
        eq(SessionTaskTable.eligibility, "frozen"),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (frozen) return yield* Effect.fail(new Unavailable())
  const id = SessionMessage.ID.create()
  const admission: SessionTask.Admission = {
    inputID: id,
    rootSessionID: SessionSchema.ID.make(established.root_session_id),
    parentSessionID: input.invocation.parentSessionID,
    parentMessageID: input.invocation.parentMessageID,
    callID: input.invocation.callID,
    promptDigest,
    childSessionID: input.childSessionID,
    description: input.description,
    agentID: input.agentID,
    locationRevision: child.revision,
    backend: "v2",
    background: input.background ?? false,
  }
  const record = SessionTask.withOwner(input.childSessionID)(
    SessionInput.admit(db, events, {
      id,
      sessionID: input.childSessionID,
      prompt: Prompt.make({ text: input.text }),
      delivery: "queue",
      task: { kind: "invocation", admission },
      commit: () =>
        Effect.gen(function* () {
          const current = yield* db
            .select({ revision: SessionTable.location_revision })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.childSessionID))
            .get()
            .pipe(Effect.orDie)
          if (!current || current.revision !== child.revision) return yield* Effect.die(new Unavailable())
          yield* SessionTask.validate(db, id)
          const stillOld = yield* db
            .select()
            .from(SessionTaskTable)
            .where(
              and(
                eq(SessionTaskTable.child_session_id, input.childSessionID),
                eq(SessionTaskTable.abandoned_unknown, true),
              ),
            )
            .orderBy(asc(SessionTaskTable.input_id))
            .all()
            .pipe(Effect.orDie)
          if (JSON.stringify(stillOld) !== JSON.stringify(old)) return yield* Effect.die(new Unavailable())
          const stillFrozen = yield* db
            .select({ inputID: SessionTaskTable.input_id })
            .from(SessionTaskTable)
            .where(
              and(
                eq(SessionTaskTable.child_session_id, input.childSessionID),
                eq(SessionTaskTable.state, "queued"),
                eq(SessionTaskTable.eligibility, "frozen"),
              ),
            )
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (stillFrozen) return yield* Effect.die(new Unavailable())
          if (active) {
            const owner = yield* SessionTask.find(db, active.input_id)
            if (!owner || owner.state !== "active" || owner.owner_generation !== observed?.owner_generation)
              return yield* Effect.die(new Unavailable())
          } else {
            const another = yield* db
              .select({ inputID: SessionTaskTable.input_id })
              .from(SessionTaskTable)
              .where(
                and(
                  eq(SessionTaskTable.child_session_id, input.childSessionID),
                  inArray(SessionTaskTable.state, ["admitted", "active"]),
                  eq(SessionTaskTable.abandoned_unknown, false),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            if (another.some((row) => row.inputID !== id)) return yield* Effect.die(new Unavailable())
          }
        }),
    }),
  )
  if (active) yield* record
  else
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => SessionTaskOwner.acquireLocalLease(database.filename!, input.childSessionID),
        catch: () => new Unavailable(),
      }),
      () => record,
      (lease) => Effect.tryPromise(() => lease.close()).pipe(Effect.orDie),
    )
  yield* execution.wake(input.childSessionID)
  return { inputID: id, state: (yield* SessionTask.find(db, id))!.state }
})

/** Reconcile one exact frozen or pending input without changing its identity. */
export const reconcile = Effect.fn("SessionTaskDelivery.reconcile")(function* (input: {
  childSessionID: SessionSchema.ID
  inputID: string
  invocation: Invocation
  operationID: string
  actor: { kind: "user" | "parent"; id: string }
  disposition: "resume_pending" | "cancel_pending"
}) {
  const database = yield* Database.Service
  const db = database.db
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const previous = yield* db
    .select()
    .from(SessionTaskOperationTable)
    .where(eq(SessionTaskOperationTable.operation_id, input.operationID))
    .get()
    .pipe(Effect.orDie)
  if (previous) {
    if (
      previous.input_id !== input.inputID ||
      previous.actor_kind !== input.actor.kind ||
      previous.actor_id !== input.actor.id ||
      previous.disposition !== input.disposition
    )
      return yield* Effect.fail(new SessionTask.AdmissionConflict())
    const task = yield* SessionTask.find(db, previous.input_id)
    if (
      !task ||
      task.child_session_id !== input.childSessionID ||
      task.parent_session_id !== input.invocation.parentSessionID ||
      task.parent_message_id !== input.invocation.parentMessageID ||
      task.call_id !== input.invocation.callID
    )
      return yield* Effect.fail(new UnknownOrForbidden())
    return {
      inputID: previous.input_id,
      disposition: previous.disposition,
      eligibility: previous.disposition === "resume_pending" ? ("eligible" as const) : ("cancelled" as const),
      capacityState: previous.capacity_state,
    }
  }
  const task = yield* SessionTask.find(db, input.inputID)
  if (
    !task ||
    task.backend !== "v2" ||
    task.child_session_id !== input.childSessionID ||
    task.parent_session_id !== input.invocation.parentSessionID ||
    task.parent_message_id !== input.invocation.parentMessageID ||
    task.call_id !== input.invocation.callID
  )
    return yield* Effect.fail(new UnknownOrForbidden())
  if (task.state !== "queued") return yield* Effect.fail(new SessionTask.AdmissionConflict())
  if (input.disposition === "resume_pending" && task.eligibility !== "frozen")
    return yield* Effect.fail(new SessionTask.AdmissionConflict())
  if (input.disposition === "resume_pending" && (!database.filename || database.filename === ":memory:"))
    return yield* Effect.fail(new Unavailable())
  const child = yield* db
    .select({ revision: SessionTable.location_revision })
    .from(SessionTable)
    .where(and(eq(SessionTable.id, input.childSessionID), eq(SessionTable.parent_id, input.invocation.parentSessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!child) return yield* Effect.fail(new UnknownOrForbidden())
  if (input.disposition === "resume_pending" && child.revision !== task.location_revision)
    return yield* Effect.fail(new Unavailable())
  const unresolved =
    input.disposition === "resume_pending"
      ? yield* db
          .select()
          .from(SessionTaskTable)
          .where(
            and(
              eq(SessionTaskTable.child_session_id, input.childSessionID),
              inArray(SessionTaskTable.state, ["admitted", "active"]),
            ),
          )
          .orderBy(asc(SessionTaskTable.input_id))
          .all()
          .pipe(Effect.orDie)
      : []
  if (unresolved.some((row) => !row.abandoned_unknown && row.input_id !== input.inputID)) {
    const observed = yield* Effect.promise(() => SessionTaskOwner.observe(database.filename!, input.childSessionID))
    if (
      !observed ||
      unresolved.some((row) => !row.abandoned_unknown && row.owner_generation !== observed.owner_generation)
    )
      return yield* Effect.fail(new Unavailable())
  }
  if (unresolved.some((row) => row.abandoned_unknown && (!row.owner_pid || !row.owner_start)))
    return yield* Effect.fail(new Unavailable())
  if (
    !(yield* Effect.forEach(
      unresolved.filter((row) => row.abandoned_unknown),
      (row) => Effect.promise(() => SessionTaskOwner.priorProcessExited(row.owner_pid!, row.owner_start!)),
    )).every(Boolean)
  )
    return yield* Effect.fail(new Unavailable())
  const live = unresolved.some((row) => !row.abandoned_unknown)
  const record = SessionTask.withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const current = yield* SessionTask.find(db, input.inputID)
      if (!current || current.state !== "queued" || current.eligibility !== task.eligibility)
        return yield* Effect.fail(new SessionTask.AdmissionConflict())
      const used = yield* db
        .select({ value: sql<number>`count(*)` })
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.root_session_id, task.root_session_id),
            inArray(SessionTaskTable.state, ["admitted", "active"]),
            eq(SessionTaskTable.abandoned_unknown, false),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const capacityState =
        input.disposition === "cancel_pending"
          ? ("not_applicable" as const)
          : (used?.value ?? 0) >= SessionTask.ACTIVE_LIMIT
            ? ("capacity_unavailable" as const)
            : ("available" as const)
      yield* events.publish(
        SessionTaskEvent.Reconciled,
        {
          sessionID: input.childSessionID,
          inputID: input.inputID,
          operationID: input.operationID,
          actorKind: input.actor.kind,
          actorID: input.actor.id,
          disposition: input.disposition,
          capacityState,
          timestamp: Date.now(),
        },
        {
          commit: () =>
            Effect.gen(function* () {
              const location = yield* db
                .select({ revision: SessionTable.location_revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.childSessionID))
                .get()
                .pipe(Effect.orDie)
              if (!location || (input.disposition === "resume_pending" && location.revision !== task.location_revision))
                return yield* Effect.die(new Unavailable())
              const old = yield* db
                .select()
                .from(SessionTaskTable)
                .where(
                  and(
                    eq(SessionTaskTable.child_session_id, input.childSessionID),
                    inArray(SessionTaskTable.state, ["admitted", "active"]),
                  ),
                )
                .orderBy(asc(SessionTaskTable.input_id))
                .all()
                .pipe(Effect.orDie)
              const ownerFacts = (rows: typeof old) =>
                rows.map((row) => [
                  row.input_id,
                  row.state,
                  row.owner_pid,
                  row.owner_start,
                  row.owner_generation,
                  row.abandoned_unknown,
                  row.archive_operation_id,
                ])
              if (
                input.disposition === "resume_pending" &&
                JSON.stringify(ownerFacts(old)) !== JSON.stringify(ownerFacts(unresolved))
              )
                return yield* Effect.die(new Unavailable())
              const currentUsed = yield* db
                .select({ value: sql<number>`count(*)` })
                .from(SessionTaskTable)
                .where(
                  and(
                    eq(SessionTaskTable.root_session_id, task.root_session_id),
                    inArray(SessionTaskTable.state, ["admitted", "active"]),
                    eq(SessionTaskTable.abandoned_unknown, false),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (
                input.disposition === "resume_pending" &&
                (currentUsed?.value ?? 0) >= SessionTask.ACTIVE_LIMIT !== (capacityState === "capacity_unavailable")
              )
                return yield* Effect.die(new Unavailable())
            }),
        },
      )
      return {
        inputID: input.inputID,
        disposition: input.disposition,
        eligibility: input.disposition === "resume_pending" ? ("eligible" as const) : ("cancelled" as const),
        capacityState,
      }
    }),
  )
  const receipt =
    input.disposition === "cancel_pending" || live
      ? yield* record
      : yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => SessionTaskOwner.acquireLocalLease(database.filename!, input.childSessionID),
            catch: () => new Unavailable(),
          }),
          () => record,
          (lease) => Effect.tryPromise(() => lease.close()).pipe(Effect.orDie),
        )
  if (input.disposition === "cancel_pending")
    yield* SessionTaskResult.recordAndWake(database, events, execution.wake, input.inputID)
  if (input.disposition === "cancel_pending" || receipt.capacityState === "available")
    yield* reassessRoot(database, SessionSchema.ID.make(task.root_session_id))
  return receipt
})

/** User-only management boundary; its caller must validate the actual instance user. */
export const archiveUnknown = Effect.fn("SessionTaskDelivery.archiveUnknown")(function* (input: {
  childSessionID: SessionSchema.ID
  inputID: string
  operationID: string
  actor: { kind: "user"; id: string }
}) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const task = yield* SessionTask.find(database.db, input.inputID)
  if (!task || task.child_session_id !== input.childSessionID) return yield* Effect.fail(new UnknownOrForbidden())
  const receipt = yield* SessionTask.archiveUnknown(database, events, input)
  yield* reassessRoot(database, SessionSchema.ID.make(task.root_session_id))
  return receipt
})

export const reassessRoot = Effect.fn("SessionTaskDelivery.reassessRoot")(function* (
  database: Database.Interface,
  rootSessionID: SessionSchema.ID,
) {
  const execution = yield* SessionExecution.Service
  const option = yield* Effect.serviceOption(SessionLocationAccess.Service)
  if (Option.isNone(option)) return
  yield* SessionTaskScheduler.reassess(database, rootSessionID, {
    wake: execution.wake,
    executable: (child) =>
      option.value.resolve(child).pipe(
        Effect.map((resolution) => resolution.status === "resolved"),
        Effect.catch(() => Effect.succeed(false)),
      ),
  })
})

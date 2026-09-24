export * as SessionTaskControl from "./task-control"

import { and, asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionExecution } from "./execution"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTaskStopTable, SessionTaskTable } from "./sql"
import { SessionTask } from "./task"
import { SessionTaskOwner } from "./task-owner"
import { SessionTaskDelivery } from "./task-delivery"

export class UnknownOrForbidden extends Error {
  readonly code = "task_unknown_or_forbidden"
}

export class Conflict extends Error {
  readonly code = "task_invocation_conflict"
}

export class Unavailable extends Error {
  readonly code = "task_control_unavailable"
}

export type Invocation = {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: string
  readonly callID: string
}

type Actor = { readonly kind: "user" | "parent"; readonly id: string }
type Member = { readonly inputID: string; readonly state: "active" | "pending" }

/** Target one durable input and the currently bound execution generation. */
export const interrupt = Effect.fn("SessionTaskControl.interrupt")(function* (input: {
  childSessionID: SessionSchema.ID
  inputID: string
  invocation: Invocation
  actor: Actor
}) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const db = database.db
  const receipt = yield* SessionTask.withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const row = yield* SessionTask.find(db, input.inputID)
      if (
        !row ||
        row.backend !== "v2" ||
        row.child_session_id !== input.childSessionID ||
        row.parent_session_id !== input.invocation.parentSessionID ||
        row.parent_message_id !== input.invocation.parentMessageID ||
        row.call_id !== input.invocation.callID
      )
        return yield* Effect.fail(new UnknownOrForbidden())
      const child = yield* db
        .select({ parentID: SessionTable.parent_id, revision: SessionTable.location_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.childSessionID))
        .get()
        .pipe(Effect.orDie)
      if (!child || child.parentID !== input.invocation.parentSessionID)
        return yield* Effect.fail(new UnknownOrForbidden())
      if (row.state === "settled") return { inputID: row.input_id, state: "already_settled" as const }
      if (row.state === "queued" || row.state === "admitted") {
        yield* events.publish(
          SessionTaskEvent.Stopped,
          {
            sessionID: input.childSessionID,
            rootSessionID: SessionSchema.ID.make(row.root_session_id),
            parentSessionID: input.invocation.parentSessionID,
            operationID: `task_interrupt:${input.inputID}`,
            intent: "interrupt",
            actorKind: input.actor.kind,
            actorID: input.actor.id,
            members: [{ inputID: row.input_id, state: "pending" }],
            timestamp: Date.now(),
          },
          {
            commit: () =>
              Effect.gen(function* () {
                const current = yield* SessionTask.find(db, input.inputID)
                if (
                  !current ||
                  current.state !== "settled" ||
                  current.outcome !== "cancelled" ||
                  current.disposition_operation_id !== `task_interrupt:${input.inputID}:${input.inputID}`
                )
                  return yield* Effect.die(new Conflict())
              }),
          },
        )
        return { inputID: row.input_id, state: "cancelled_pending" as const }
      }
      if (child.revision !== row.location_revision || !database.filename || database.filename === ":memory:")
        return { inputID: row.input_id, state: "unavailable" as const }
      const observed = yield* Effect.promise(() => SessionTaskOwner.observe(database.filename!, input.childSessionID))
      if (!observed || observed.owner_generation !== row.owner_generation)
        return { inputID: row.input_id, state: "unavailable" as const }
      const requested = yield* db.transaction(
        () =>
          Effect.gen(function* () {
            const current = yield* SessionTask.find(db, input.inputID)
            const location = yield* db
              .select({ revision: SessionTable.location_revision })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.childSessionID))
              .get()
              .pipe(Effect.orDie)
            if (!current || current.state === "settled") return "already_settled" as const
            if (
              current.state !== "active" ||
              current.owner_generation !== observed.owner_generation ||
              location?.revision !== row.location_revision
            )
              return "unavailable" as const
            return (yield* execution.requestInterruptExact(
              input.childSessionID,
              input.inputID,
              observed.owner_generation,
            ))
              ? ("requested" as const)
              : ("unavailable" as const)
          }),
        { behavior: "immediate" },
      )
      return { inputID: row.input_id, state: requested }
    }),
  )
  if (receipt.state === "cancelled_pending") {
    const row = yield* SessionTask.find(db, input.inputID)
    if (row) yield* SessionTaskDelivery.reassessRoot(database, SessionSchema.ID.make(row.root_session_id))
  }
  return receipt
})

/** Freeze the first committed child scope, cancel pending rows, then signal its exact active owner. */
export const stop = Effect.fn("SessionTaskControl.stop")(function* (input: {
  parentSessionID: SessionSchema.ID
  childSessionID: SessionSchema.ID
  operationID: string
  actor: Actor
}) {
  if (!input.operationID) return yield* Effect.fail(new Conflict())
  const database = yield* Database.Service
  const db = database.db
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const receipt = yield* SessionTask.withOwner(input.childSessionID)(
    Effect.gen(function* () {
      const child = yield* db
        .select({ parentID: SessionTable.parent_id, revision: SessionTable.location_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.childSessionID))
        .get()
        .pipe(Effect.orDie)
      if (!child || child.parentID !== input.parentSessionID) return yield* Effect.fail(new UnknownOrForbidden())
      const previous = yield* db
        .select()
        .from(SessionTaskStopTable)
        .where(eq(SessionTaskStopTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.orDie)
      if (
        previous &&
        (previous.child_session_id !== input.childSessionID ||
          previous.actor_kind !== input.actor.kind ||
          previous.actor_id !== input.actor.id ||
          previous.intent !== "stop")
      )
        return yield* Effect.fail(new Conflict())
      const rows = previous
        ? []
        : yield* db
            .select()
            .from(SessionTaskTable)
            .where(
              and(
                eq(SessionTaskTable.child_session_id, input.childSessionID),
                inArray(SessionTaskTable.state, ["queued", "admitted", "active"]),
              ),
            )
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
            .all()
            .pipe(Effect.orDie)
      if (!previous && rows.some((row) => row.backend !== "v2" || row.parent_session_id !== input.parentSessionID))
        return yield* Effect.fail(new UnknownOrForbidden())
      const established = previous
        ? undefined
        : (rows[0] ??
          (yield* db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.child_session_id, input.childSessionID))
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
            .limit(1)
            .get()
            .pipe(Effect.orDie)))
      if (
        !previous &&
        (!established || established.backend !== "v2" || established.parent_session_id !== input.parentSessionID)
      )
        return yield* Effect.fail(new UnknownOrForbidden())
      const members: readonly Member[] =
        previous?.members ??
        rows.map((row) => ({
          inputID: row.input_id,
          state: row.state === "active" ? ("active" as const) : ("pending" as const),
        }))
      if (!previous) {
        if (!established) return yield* Effect.fail(new UnknownOrForbidden())
        yield* events.publish(
          SessionTaskEvent.Stopped,
          {
            sessionID: input.childSessionID,
            rootSessionID: SessionSchema.ID.make(established.root_session_id),
            parentSessionID: input.parentSessionID,
            operationID: input.operationID,
            intent: "stop",
            actorKind: input.actor.kind,
            actorID: input.actor.id,
            members,
            timestamp: Date.now(),
          },
          {
            commit: () =>
              Effect.gen(function* () {
                const current = yield* db
                  .select()
                  .from(SessionTaskTable)
                  .where(
                    and(
                      eq(SessionTaskTable.child_session_id, input.childSessionID),
                      inArray(SessionTaskTable.state, ["queued", "admitted", "active"]),
                    ),
                  )
                  .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
                  .all()
                  .pipe(Effect.orDie)
                const covered = members.filter((member) => member.state === "active")
                if (
                  current.length !== covered.length ||
                  current.some((row, index) => row.input_id !== covered[index]?.inputID || row.state !== "active")
                )
                  return yield* Effect.die(new Conflict())
                const pending = yield* Effect.forEach(
                  members.filter((member) => member.state === "pending"),
                  (member) => SessionTask.find(db, member.inputID),
                )
                if (
                  pending.some(
                    (row, index) =>
                      !row ||
                      row.state !== "settled" ||
                      row.outcome !== "cancelled" ||
                      row.disposition_operation_id !==
                        `${input.operationID}:${members.filter((member) => member.state === "pending")[index]?.inputID}`,
                  )
                )
                  return yield* Effect.die(new Conflict())
              }),
          },
        )
      }
      const result = yield* Effect.forEach(members, (member) =>
        Effect.gen(function* () {
          if (member.state === "pending") return { inputID: member.inputID, state: "cancelled_pending" as const }
          const row = yield* SessionTask.find(db, member.inputID)
          if (!row || row.child_session_id !== input.childSessionID)
            return { inputID: member.inputID, state: "unavailable" as const }
          if (row.state === "settled") return { inputID: member.inputID, state: "already_settled" as const }
          if (
            row.state !== "active" ||
            row.location_revision !== child.revision ||
            !database.filename ||
            database.filename === ":memory:"
          )
            return { inputID: member.inputID, state: "unavailable" as const }
          const observed = yield* Effect.promise(() =>
            SessionTaskOwner.observe(database.filename!, input.childSessionID),
          )
          if (!observed || observed.owner_generation !== row.owner_generation)
            return { inputID: member.inputID, state: "unavailable" as const }
          const requested = yield* execution.requestInterruptExact(
            input.childSessionID,
            member.inputID,
            observed.owner_generation,
          )
          return { inputID: member.inputID, state: requested ? ("requested" as const) : ("unavailable" as const) }
        }),
      )
      return { operationID: input.operationID, data: result }
    }),
  )
  if (receipt.data.some((member) => member.state === "cancelled_pending")) {
    const first = yield* SessionTask.find(db, receipt.data[0]!.inputID)
    if (first) yield* SessionTaskDelivery.reassessRoot(database, SessionSchema.ID.make(first.root_session_id))
  }
  return receipt
})

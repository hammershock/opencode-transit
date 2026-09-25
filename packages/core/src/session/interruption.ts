export * as SessionInterruption from "./interruption"

import { and, desc, eq } from "drizzle-orm"
import { Deferred, Effect, Option } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionExecution } from "./execution"
import { SessionLegacyOwner } from "./legacy-owner"
import { SessionSchema } from "./schema"
import { SessionTaskResult } from "./task-result"
import { SessionExecutionPauseTable, SessionInterruptionTable, SessionTable, SessionTaskTable } from "./sql"

export class UnknownOrForbidden extends Error {
  readonly code = "session_unknown_or_forbidden"
}

export class Conflict extends Error {
  readonly code = "interrupt_operation_conflict"
}

export class Unavailable extends Error {
  readonly code = "interrupt_owner_unavailable"
}

export type Actor = { kind: "user" | "agent" | "system" | "unknown"; id: string }
type RequestInput = { sessionID: SessionSchema.ID; operationID: string; actor: Actor }
const operations = KeyedMutex.makeUnsafe<string>()
const resumed = new Map<SessionSchema.ID, Set<Deferred.Deferred<void>>>()

/** Record the actor before signalling the exact live generation. */
export const request = Effect.fn("SessionInterruption.request")(function* (input: RequestInput) {
  return yield* Effect.uninterruptible(operations.withLock(input.operationID)(requestWithin(input)))
})

const requestWithin = Effect.fn("SessionInterruption.requestWithin")(function* (input: RequestInput) {
  if (!input.operationID || !input.actor.id) return yield* Effect.fail(new Conflict())
  const db = (yield* Database.Service).db
  const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
  const session = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* Effect.fail(new UnknownOrForbidden())
  const previous = yield* db
    .select()
    .from(SessionInterruptionTable)
    .where(eq(SessionInterruptionTable.operation_id, input.operationID))
    .get()
    .pipe(Effect.orDie)
  if (previous) {
    if (
      previous.session_id !== input.sessionID ||
      previous.actor_kind !== input.actor.kind ||
      previous.actor_id !== input.actor.id
    )
      return yield* Effect.fail(new Conflict())
    if (previous.state !== "requested") return previous
  }
  const legacy = previous ? undefined : SessionLegacyOwner.generation(input.sessionID)
  const canonical = previous || !execution ? undefined : yield* execution.generation(input.sessionID)
  if (legacy && canonical) return yield* Effect.fail(new Unavailable())
  const generation = previous?.generation ?? legacy ?? canonical
  if (!generation) {
    const task = yield* db
      .select({ input_id: SessionTaskTable.input_id })
      .from(SessionTaskTable)
      .where(and(eq(SessionTaskTable.child_session_id, input.sessionID), eq(SessionTaskTable.state, "active")))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (task) return yield* Effect.fail(new Unavailable())
    return { state: "idle" as const, session_id: input.sessionID }
  }
  const backend = previous?.backend ?? (legacy ? ("v1" as const) : ("v2" as const))
  if (
    previous &&
    ((backend === "v1" && SessionLegacyOwner.generation(input.sessionID) !== generation) ||
      (backend === "v2" && (!execution || (yield* execution.generation(input.sessionID)) !== generation)))
  )
    return yield* Effect.fail(new Unavailable())
  const requested =
    previous ??
    (yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionInterruptionTable)
            .where(eq(SessionInterruptionTable.operation_id, input.operationID))
            .get()
          if (existing) {
            if (
              existing.session_id !== input.sessionID ||
              existing.actor_kind !== input.actor.kind ||
              existing.actor_id !== input.actor.id
            )
              return yield* Effect.fail(new Conflict())
            return existing
          }
          yield* tx
            .insert(SessionInterruptionTable)
            .values({
              operation_id: input.operationID,
              session_id: input.sessionID,
              backend,
              generation,
              actor_kind: input.actor.kind,
              actor_id: input.actor.id,
              state: "requested",
              time_requested: Date.now(),
            })
            .run()
          yield* tx
            .insert(SessionExecutionPauseTable)
            .values({
              session_id: input.sessionID,
              operation_id: input.operationID,
              time_created: Date.now(),
            })
            .onConflictDoNothing()
            .run()
          return yield* tx
            .select()
            .from(SessionInterruptionTable)
            .where(eq(SessionInterruptionTable.operation_id, input.operationID))
            .get()
        }),
      { behavior: "immediate" },
    ))
  if (!requested) return yield* Effect.fail(new Conflict())
  if (requested.state !== "requested") return requested
  yield* SessionTaskResult.stop(yield* Database.Service, yield* EventV2.Service, input.sessionID)
  const outcome =
    backend === "v1"
      ? yield* SessionLegacyOwner.interruptGeneration(input.sessionID, generation)
      : execution
        ? yield* execution.interruptGeneration(input.sessionID, generation)
        : yield* Effect.fail(new Unavailable())
  yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx
          .update(SessionInterruptionTable)
          .set({ state: outcome, time_settled: Date.now() })
          .where(
            and(
              eq(SessionInterruptionTable.operation_id, input.operationID),
              eq(SessionInterruptionTable.state, "requested"),
            ),
          )
          .run()
        if (outcome !== "interrupted")
          yield* tx
            .delete(SessionExecutionPauseTable)
            .where(
              and(
                eq(SessionExecutionPauseTable.session_id, input.sessionID),
                eq(SessionExecutionPauseTable.operation_id, input.operationID),
              ),
            )
            .run()
      }),
    { behavior: "immediate" },
  )
  return yield* db
    .select()
    .from(SessionInterruptionTable)
    .where(eq(SessionInterruptionTable.operation_id, input.operationID))
    .get()
    .pipe(Effect.orDie)
})

export const latest = Effect.fn("SessionInterruption.latest")(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  return yield* db
    .select()
    .from(SessionInterruptionTable)
    .where(eq(SessionInterruptionTable.session_id, sessionID))
    .orderBy(desc(SessionInterruptionTable.time_requested))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

/** Explicit continuation thaws old queued work; ordinary messages leave it paused. */
export const resumePending = Effect.fn("SessionInterruption.resumePending")(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  yield* db
    .delete(SessionExecutionPauseTable)
    .where(eq(SessionExecutionPauseTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  for (const listener of resumed.get(sessionID) ?? []) Deferred.doneUnsafe(listener, Effect.void)
})

/** Legacy in-memory follow-ups wait on a signal after their predecessor settles. */
export const waitUntilResumed = Effect.fn("SessionInterruption.waitUntilResumed")(function* (
  sessionID: SessionSchema.ID,
) {
  const db = (yield* Database.Service).db
  while (true) {
    const signal = yield* Deferred.make<void>()
    const listeners = resumed.get(sessionID) ?? new Set<Deferred.Deferred<void>>()
    listeners.add(signal)
    resumed.set(sessionID, listeners)
    const paused = yield* db
      .select({ session_id: SessionExecutionPauseTable.session_id })
      .from(SessionExecutionPauseTable)
      .where(eq(SessionExecutionPauseTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!paused) {
      listeners.delete(signal)
      if (!listeners.size) resumed.delete(sessionID)
      return
    }
    yield* Deferred.await(signal).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          listeners.delete(signal)
          if (!listeners.size) resumed.delete(sessionID)
        }),
      ),
    )
  }
})

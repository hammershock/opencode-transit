export * as SessionTaskWait from "./task-wait"

import { Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { LocationServiceMap } from "../location-service-map"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionTask as TaskSchema } from "@opencode-ai/schema/session-task"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionTaskOwner } from "./task-owner"
import { SessionTaskView } from "./task-view"
import { SessionTable } from "./sql"
import { and, eq, gt, sql } from "drizzle-orm"

export class InvalidRequest extends Error {
  readonly code = "task_wait_invalid_request"
}

export class UnknownOrForbidden extends Error {
  readonly code = "task_unknown_or_forbidden"
}

export class Unavailable extends Error {
  readonly code = "task_wait_unavailable"
}

type Target = typeof TaskSchema.ExactTarget.Type
type View = typeof TaskSchema.View.Type

type Input = {
  readonly parentSessionID: SessionSchema.ID
  readonly targets: readonly Target[]
  readonly until?: "terminal" | "change"
  readonly timeoutMs?: number
}

function reason(
  views: readonly View[],
  baseline: readonly View[],
  until: "terminal" | "change",
): "terminal" | "needs_input" | "unavailable" | "state_changed" | undefined {
  if (views.some((view) => view.lifecycle === "settled")) return "terminal" as const
  if (views.some((view) => view.phase === "permission" || view.phase === "question")) return "needs_input" as const
  if (views.some((view) => view.lifecycle === "active" && view.runtime !== "observed")) return "unavailable" as const
  if (
    until === "change" &&
    views.some(
      (view, index) =>
        view.lifecycle !== baseline[index]?.lifecycle ||
        view.phase !== baseline[index]?.phase ||
        view.eligibility !== baseline[index]?.eligibility ||
        view.runtime !== baseline[index]?.runtime ||
        view.queued_count !== baseline[index]?.queued_count ||
        view.last_progress_at !== baseline[index]?.last_progress_at,
    )
  )
    return "state_changed" as const
  return undefined
}

export const wait = Effect.fn("SessionTaskWait.wait")(function* (input: Input) {
  if (
    input.targets.length < 1 ||
    input.targets.length > 32 ||
    (input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) ||
    new Set(input.targets.map((target) => `${target.task_id}\u0000${target.input_id}`)).size !== input.targets.length
  )
    return yield* Effect.fail(new InvalidRequest())
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const locations = yield* LocationServiceMap.Service
  const parent = yield* database.db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.parentSessionID))
    .get()
    .pipe(Effect.orDie)
  if (!parent) return yield* Effect.fail(new UnknownOrForbidden())
  const timeout = input.timeoutMs ?? 30_000
  const until = input.until ?? "terminal"
  const started = Date.now()
  const cursor = new Map<string, number>()
  // Anchor before the snapshot. Durable streams subscribe before reading this gap.
  for (const aggregateID of [input.parentSessionID, ...new Set(input.targets.map((target) => target.task_id))])
    cursor.set(aggregateID, yield* EventV2.latestSequence(database.db, aggregateID))
  const read = () =>
    Effect.forEach(input.targets, (target) =>
      Effect.gen(function* () {
        if (target.invocation.parent_session_id !== input.parentSessionID)
          return yield* Effect.fail(new UnknownOrForbidden())
        const view = yield* SessionTaskView.read(database, {
          parentSessionID: input.parentSessionID,
          childSessionID: target.task_id,
          invocation: target.invocation,
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskView.TargetUnavailable ? new UnknownOrForbidden() : error,
          ),
        )
        if (view.input_id !== target.input_id) return yield* Effect.fail(new UnknownOrForbidden())
        return yield* SessionTaskView.withObservedPhase(database, view, locations, { strict: true }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(new Unavailable()),
          ),
        )
      }),
    )
  const parentInput = () =>
    database.db
      .select({ seq: EventTable.seq })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, input.parentSessionID),
          gt(EventTable.seq, cursor.get(input.parentSessionID) ?? -1),
          eq(EventTable.type, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)),
          sql`json_type(${EventTable.data}, '$.task') is null`,
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie, Effect.map(Boolean))
  return yield* Effect.gen(function* () {
    const children = new Set(input.targets.map((target) => target.task_id))
    const phaseChanged = yield* Queue.sliding<void>(1)
    yield* Effect.acquireRelease(
      events.listen((event) => {
        if (
          ![
            PermissionV2.Event.Asked.type,
            PermissionV2.Event.Replied.type,
            QuestionV2.Event.Asked.type,
            QuestionV2.Event.Replied.type,
            QuestionV2.Event.Rejected.type,
          ].some((type) => type === event.type) ||
          typeof event.data !== "object" ||
          event.data === null ||
          !("sessionID" in event.data) ||
          typeof event.data.sessionID !== "string" ||
          !children.has(SessionSchema.ID.make(event.data.sessionID))
        )
          return Effect.void
        return Queue.offer(phaseChanged, undefined).pipe(Effect.asVoid)
      }),
      (unsubscribe) => unsubscribe,
    )
    const watchers = yield* Effect.acquireRelease(
      Effect.sync(() =>
        database.filename && database.filename !== ":memory:"
          ? input.targets.map((target) => SessionTaskOwner.watch(database.filename!, target.task_id))
          : [],
      ),
      (owned) => Effect.sync(() => owned.forEach((watcher) => watcher.close())),
    )
    let baseline: readonly View[] | undefined
    while (true) {
      const views = yield* read()
      baseline ??= views
      const current = reason(views, baseline, until)
      if (current) return { reason: current, timed_out: false, data: views }
      const remaining = timeout - (Date.now() - started)
      if (remaining <= 0) {
        const inputReady = yield* parentInput()
        return inputReady
          ? { reason: "parent_input" as const, timed_out: false, data: views }
          : { reason: "timeout" as const, timed_out: true, data: views }
      }
      const signal = (aggregateID: string) =>
        events.durable({ aggregateID, after: cursor.get(aggregateID) }).pipe(
          Stream.filter(
            (event) =>
              aggregateID !== input.parentSessionID ||
              (Schema.is(SessionEvent.PromptAdmitted)(event) && !event.data.task),
          ),
          Stream.runHead,
          Effect.flatMap((event) =>
            Option.match(event, {
              onNone: () => Effect.fail(new Unavailable()),
              onSome: (item) => Effect.succeed({ kind: "event" as const, aggregateID, seq: item.durable!.seq }),
            }),
          ),
        )
      const signals = [
        ...[...cursor.keys()].map(signal),
        ...watchers.map((watcher, index) =>
          Effect.promise(() => watcher.changed).pipe(Effect.as({ kind: "owner" as const, index })),
        ),
        Queue.take(phaseChanged).pipe(Effect.as({ kind: "phase" as const })),
      ]
      const wake = yield* Effect.raceAll(signals).pipe(Effect.timeoutOption(remaining))
      if (Option.isNone(wake)) {
        const final = yield* read()
        const finalReason = reason(final, baseline, until)
        const inputReady = finalReason ? false : yield* parentInput()
        return finalReason
          ? { reason: finalReason, timed_out: false, data: final }
          : inputReady
            ? { reason: "parent_input" as const, timed_out: false, data: final }
            : { reason: "timeout" as const, timed_out: true, data: final }
      }
      if (wake.value.kind === "event") {
        cursor.set(wake.value.aggregateID, wake.value.seq)
        if (wake.value.aggregateID === input.parentSessionID)
          return { reason: "parent_input" as const, timed_out: false, data: yield* read() }
      }
      if (wake.value.kind === "owner" && database.filename) {
        watchers[wake.value.index]?.close()
        watchers[wake.value.index] = SessionTaskOwner.watch(database.filename, input.targets[wake.value.index]!.task_id)
      }
    }
  }).pipe(Effect.scoped)
})

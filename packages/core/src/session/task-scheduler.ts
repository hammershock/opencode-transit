export * as SessionTaskScheduler from "./task-scheduler"

import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionExecutionPauseTable, SessionTaskTable } from "./sql"
import { SessionTask } from "./task"

/**
 * One event-driven root reassessment. This only schedules candidates; the
 * runner must acquire the child lease and atomically claim a slot at Prompted.
 */
export const reassess = Effect.fn("SessionTaskScheduler.reassess")(function* (
  database: Database.Interface,
  rootSessionID: SessionSchema.ID,
  input: {
    wake: (childSessionID: SessionSchema.ID) => Effect.Effect<void>
    executable: (childSessionID: SessionSchema.ID) => Effect.Effect<boolean>
  },
) {
  const candidates = yield* database.db.transaction(
    () =>
      Effect.gen(function* () {
        const used = yield* database.db
          .select({ value: sql<number>`count(*)` })
          .from(SessionTaskTable)
          .where(
            and(
              eq(SessionTaskTable.root_session_id, rootSessionID),
              inArray(SessionTaskTable.state, ["admitted", "active"]),
              eq(SessionTaskTable.abandoned_unknown, false),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const slots = SessionTask.ACTIVE_LIMIT - (used?.value ?? 0)
        if (slots <= 0) return { slots: 0, children: [] as SessionSchema.ID[] }
        const queued = yield* database.db
          .select()
          .from(SessionTaskTable)
          .where(and(eq(SessionTaskTable.root_session_id, rootSessionID), eq(SessionTaskTable.state, "queued")))
          .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
          .all()
          .pipe(Effect.orDie)
        const pending = queued.filter((row) => row.eligibility !== "cancelled")
        const heads = pending.filter(
          (row, index) =>
            pending.findIndex((candidate) => candidate.child_session_id === row.child_session_id) === index,
        )
        const active = yield* database.db
          .select({ childID: SessionTaskTable.child_session_id })
          .from(SessionTaskTable)
          .where(
            and(
              eq(SessionTaskTable.root_session_id, rootSessionID),
              inArray(SessionTaskTable.state, ["admitted", "active"]),
              eq(SessionTaskTable.abandoned_unknown, false),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const busy = new Set(active.map((row) => row.childID))
        return {
          slots,
          children: heads
            .filter((row) => row.backend === "v2" && row.eligibility === "eligible" && !busy.has(row.child_session_id))
            .map((row) => SessionSchema.ID.make(row.child_session_id)),
        }
      }),
    { behavior: "immediate" },
  )
  const paused = candidates.children.length
    ? yield* database.db
        .select({ sessionID: SessionExecutionPauseTable.session_id })
        .from(SessionExecutionPauseTable)
        .where(inArray(SessionExecutionPauseTable.session_id, candidates.children))
        .all()
        .pipe(Effect.orDie)
    : []
  const blocked = new Set(paused.map((row) => row.sessionID))
  const ready = yield* Effect.filter(
    candidates.children.filter((child) => !blocked.has(child)),
    input.executable,
  )
  const selected = ready.slice(0, candidates.slots)
  yield* Effect.forEach(selected, input.wake, { discard: true })
  return selected
})

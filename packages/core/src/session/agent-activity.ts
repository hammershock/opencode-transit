export * as SessionAgentActivity from "./agent-activity"

import { and, asc, eq, gt, lte } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { SessionAgentActivityTable, SessionMessageTable } from "./sql"
import { SessionSchema } from "./schema"

/** A page uses one receiver aggregate sequence for live and replay ordering. */
export const page = Effect.fn("SessionAgentActivity.page")(function* (input: {
  sessionID: SessionSchema.ID
  after?: number
  limit?: number
}) {
  const db = (yield* Database.Service).db
  const after = input.after ?? -1
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500)
  const events = yield* db
    .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, input.sessionID), gt(EventTable.seq, after)))
    .orderBy(asc(EventTable.seq))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
  const end = events.at(-1)?.seq
  if (end === undefined) return { activities: [], anchors: [], next: null }
  const [activities, canonical] = yield* Effect.all([
    db
      .select()
      .from(SessionAgentActivityTable)
      .where(
        and(
          eq(SessionAgentActivityTable.session_id, input.sessionID),
          gt(SessionAgentActivityTable.seq, after),
          lte(SessionAgentActivityTable.seq, end),
        ),
      )
      .orderBy(asc(SessionAgentActivityTable.seq))
      .all(),
    db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          gt(SessionMessageTable.seq, after),
          lte(SessionMessageTable.seq, end),
        ),
      )
      .all(),
  ]).pipe(Effect.orDie)
  const eventAnchors = events.flatMap((event) => {
    if (event.type === "message.updated.1") {
      const info = event.data.info
      if (!info || typeof info !== "object" || !("id" in info) || typeof info.id !== "string") return []
      const time = "time" in info ? info.time : undefined
      return [
        { id: info.id, seq: event.seq },
        ...(time && typeof time === "object" && "completed" in time && time.completed
          ? [{ id: `footer:${info.id}`, seq: event.seq }]
          : []),
      ]
    }
    if (event.type === "message.part.updated.1") {
      const part = event.data.part
      return part && typeof part === "object" && "id" in part && typeof part.id === "string"
        ? [{ id: part.id, seq: event.seq }]
        : []
    }
    if (event.type === "session.next.step.ended.2" || event.type === "session.next.step.failed.1") {
      const id = event.data.assistantMessageID
      return typeof id === "string" ? [{ id: `footer:${id}`, seq: event.seq }] : []
    }
    const key = event.type.startsWith("session.next.text.started.")
      ? "textID"
      : event.type.startsWith("session.next.reasoning.started.")
        ? "reasoningID"
        : event.type.startsWith("session.next.tool.input.started.") ||
            event.type.startsWith("session.next.tool.called.")
          ? "callID"
          : undefined
    const id = key ? event.data[key] : undefined
    return typeof id === "string" ? [{ id, seq: event.seq }] : []
  })
  return {
    activities: activities.map((item) => ({
      id: item.event_id,
      seq: item.seq,
      kind: item.kind,
      alias: item.alias,
      sessionID: item.subject_session_id,
      waitCallID: item.wait_call_id,
      actor: item.actor_kind,
    })),
    anchors: [...eventAnchors, ...canonical],
    next: events.length === limit ? end : null,
  }
})

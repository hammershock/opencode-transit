export * as SessionTaskView from "./task-view"

import { and, asc, desc, eq, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTask as TaskSchema } from "@opencode-ai/schema/session-task"
import { SessionTaskOwner } from "./task-owner"
import { MessageTable, PartTable, SessionTable, SessionTaskTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"

export class TargetUnavailable extends Error {
  readonly code = "task_target_unavailable"
  constructor() {
    super("task_target_unavailable")
  }
}

/** A read is passive: it never wakes a Session or repairs an execution owner. */
export const read = Effect.fn("SessionTaskView.read")(function* (
  database: Database.Interface,
  input: {
    parentSessionID: SessionSchema.ID
    childSessionID: SessionSchema.ID
    invocation?: TaskSchema.Target["invocation"]
  },
) {
  const db = database.db
  const child = yield* db
    .select()
    .from(SessionTable)
    .where(and(eq(SessionTable.id, input.childSessionID), eq(SessionTable.parent_id, input.parentSessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!child) return yield* Effect.fail(new TargetUnavailable())
  const rows = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, child.id),
        eq(SessionTaskTable.parent_session_id, input.parentSessionID),
      ),
    )
    .orderBy(desc(SessionTaskTable.time_created), desc(SessionTaskTable.input_id))
    .limit(65)
    .all()
    .pipe(Effect.orDie)
  const row = input.invocation
    ? yield* db
        .select()
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.child_session_id, child.id),
            eq(SessionTaskTable.parent_session_id, input.parentSessionID),
            eq(SessionTaskTable.parent_message_id, input.invocation.parent_message_id),
            eq(SessionTaskTable.call_id, input.invocation.call_id),
          ),
        )
        .get()
        .pipe(Effect.orDie)
    : rows[0]
  if (input.invocation && (!row || input.invocation.parent_session_id !== input.parentSessionID))
    return yield* Effect.fail(new TargetUnavailable())
  const location = {
    ...(child.target?.type === "rexd" ? { target_id: child.target.targetID } : {}),
    ...(child.last_known_target_name ? { target_name: child.last_known_target_name } : {}),
  }
  if (!row) {
    const view: TaskSchema.View = {
      target: { task_id: child.id },
      description: child.title,
      agent_id: child.agent ?? "unknown",
      location,
      lifecycle: "unscoped_legacy" as const,
      runtime: "unknown" as const,
      phase: "unknown" as const,
      eligibility: "none" as const,
      cancellation: "none" as const,
      lifecycle_source: "legacy_projection" as const,
      read_at: Date.now(),
      active_tools: [],
      active_tool_count: 0,
      queued_count: 0,
    }
    return view
  }

  const invocation = {
    parent_session_id: SessionSchema.ID.make(row.parent_session_id),
    parent_message_id: row.parent_message_id,
    call_id: row.call_id,
  }
  const queued_count = yield* db
    .select({ value: sql<number>`count(*)` })
    .from(SessionTaskTable)
    .where(and(eq(SessionTaskTable.child_session_id, child.id), eq(SessionTaskTable.state, "queued")))
    .get()
    .pipe(Effect.orDie)
  const observed =
    database.filename && database.filename !== ":memory:"
      ? yield* Effect.promise(() => SessionTaskOwner.observe(database.filename!, child.id))
      : undefined
  const live = row.state === "active" && observed?.owner_generation === row.owner_generation
  const partOwner = and(
    eq(PartTable.session_id, child.id),
    eq(MessageTable.session_id, child.id),
    // A Task input is the child User message; V1 Assistant messages point to it through parentID.
    or(
      sql`${MessageTable.id} = ${row.input_id}`,
      and(
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.parentID') = ${row.input_id}`,
      ),
    ),
  )
  const lastPart = yield* db
    .select({ updated: PartTable.time_updated })
    .from(PartTable)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    .where(partOwner)
    .orderBy(desc(PartTable.time_updated))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const running = live
    ? and(
        partOwner,
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
      )
    : undefined
  const count = running
    ? yield* db
        .select({ value: sql<number>`count(*)` })
        .from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(running)
        .get()
        .pipe(Effect.orDie)
    : undefined
  const parts = running
    ? yield* db
        .select({ data: PartTable.data })
        .from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(running)
        .orderBy(asc(PartTable.id))
        .limit(16)
        .all()
        .pipe(Effect.orDie)
    : []
  const active_tools = parts
    .filter((part) => part.data.type === "tool")
    .map((part) => ({
      name: (part.data as SessionV1.ToolPart).tool,
      call_id: (part.data as SessionV1.ToolPart).callID,
      ...((part.data as SessionV1.ToolPart).state.status === "running"
        ? { started_at: (part.data as SessionV1.ToolPart & { state: SessionV1.ToolStateRunning }).state.time.start }
        : {}),
    }))
  const active = rows.find((item) => item.state === "active" || item.state === "admitted")
  const activeObserved = active && observed?.owner_generation === active.owner_generation
  const view: TaskSchema.View = {
    target: { task_id: child.id, invocation },
    description: row.description,
    agent_id: row.agent_id,
    location,
    lifecycle: row.state === "queued" ? ("admitted" as const) : row.state,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    runtime: live ? ("observed" as const) : row.state === "settled" ? ("unavailable" as const) : ("unknown" as const),
    phase:
      row.state === "queued"
        ? ("queued" as const)
        : live
          ? active_tools.length
            ? ("tool" as const)
            : ("model" as const)
          : ("unknown" as const),
    eligibility:
      row.state === "queued"
        ? active && !activeObserved
          ? ("frozen" as const)
          : ("eligible" as const)
        : ("none" as const),
    cancellation: "none" as const,
    lifecycle_source: "durable" as const,
    ...(live && observed
      ? {
          runtime_observation: {
            source: observed.source,
            owner_generation: observed.owner_generation,
            observed_at: observed.observed_at,
          },
        }
      : {}),
    read_at: Date.now(),
    ...(lastPart ? { last_progress_at: lastPart.updated } : {}),
    active_tools,
    active_tool_count: count?.value ?? 0,
    ...(active
      ? {
          active_invocation: {
            parent_session_id: SessionSchema.ID.make(active.parent_session_id),
            parent_message_id: active.parent_message_id,
            call_id: active.call_id,
          },
        }
      : {}),
    queued_count: queued_count?.value ?? 0,
    ...(row.abandoned_unknown ? { abandoned_unknown: true } : {}),
    ...(row.result_message_id ? { result: { message_id: row.result_message_id, truncated: false } } : {}),
  }
  return view
})

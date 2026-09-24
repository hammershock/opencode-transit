export * as SessionTaskView from "./task-view"

import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionTask as TaskSchema } from "@opencode-ai/schema/session-task"
import { SessionTaskOwner } from "./task-owner"
import { SessionTask } from "./task"
import { MessageTable, PartTable, SessionTable, SessionTaskTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { LocationServiceMap } from "../location-service-map"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionPolicyStore } from "./policy"

export class TargetUnavailable extends Error {
  readonly code = "task_target_unavailable"
  constructor() {
    super("task_target_unavailable")
  }
}

export class InvalidCursor extends Error {
  readonly code = "task_status_invalid_cursor"
  constructor() {
    super("task_status_invalid_cursor")
  }
}

const MAX_PAGE = 32

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["children", "invocations"]),
  parent: Schema.String,
  child: Schema.optional(Schema.String),
  upper: Schema.Int,
  boundTime: Schema.Int,
  boundID: Schema.String,
  afterTime: Schema.Int,
  afterID: Schema.String,
})
type Cursor = typeof Cursor.Type

function decodeCursor(value: string | undefined, kind: Cursor["kind"], parent: string, child?: string) {
  if (!value) return Effect.succeed(undefined)
  return Effect.try({
    try: () => {
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
        Buffer.from(value, "base64url").toString("utf8"),
      ).valueOrUndefined
      const cursor = Schema.decodeUnknownOption(Cursor)(parsed).valueOrUndefined
      if (
        value.length > 512 ||
        !cursor ||
        cursor.kind !== kind ||
        cursor.parent !== parent ||
        cursor.child !== child ||
        cursor.upper < 0
      )
        throw new InvalidCursor()
      return cursor
    },
    catch: () => new InvalidCursor(),
  })
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function pageLimit(value?: number) {
  return Math.min(Math.max(value ?? 16, 1), MAX_PAGE)
}

/** Enumerate direct children through a fixed insertion upper bound. Later admissions stay on a later page set. */
export const children = Effect.fn("SessionTaskView.children")(function* (
  database: Database.Interface,
  input: { parentSessionID: SessionSchema.ID; cursor?: string; limit?: number; includeResults?: boolean },
) {
  const db = database.db
  const parent = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.parentSessionID))
    .get()
    .pipe(Effect.orDie)
  if (!parent) return yield* Effect.fail(new TargetUnavailable())
  const cursor = yield* decodeCursor(input.cursor, "children", input.parentSessionID)
  const position = sql<number>`${SessionTable}.rowid`
  const boundary =
    cursor ??
    (yield* db
      .select({
        upper: sql<number>`coalesce(max(${position}), 0)`,
        boundTime: sql<number>`coalesce(max(${SessionTable.time_created}), 0)`,
        boundID: sql<string>`coalesce(min(${SessionTable.id}), '')`,
      })
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, input.parentSessionID))
      .get()
      .pipe(Effect.orDie))!
  const limit = pageLimit(input.limit)
  const rows = yield* db
    .select({ id: SessionTable.id, created: SessionTable.time_created })
    .from(SessionTable)
    .where(
      and(
        eq(SessionTable.parent_id, input.parentSessionID),
        lte(position, boundary.upper),
        lte(SessionTable.time_created, boundary.boundTime),
        sql`${SessionTable.id} >= ${boundary.boundID}`,
        cursor
          ? or(
              gt(SessionTable.time_created, cursor.afterTime),
              and(
                eq(SessionTable.time_created, cursor.afterTime),
                gt(SessionTable.id, SessionSchema.ID.make(cursor.afterID)),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: yield* Effect.forEach(page, (row) =>
      read(database, {
        parentSessionID: input.parentSessionID,
        childSessionID: row.id,
        includeResults: input.includeResults,
      }),
    ),
    ...(rows.length > limit && last
      ? {
          next: encodeCursor({
            version: 1,
            kind: "children",
            parent: input.parentSessionID,
            upper: boundary.upper,
            boundTime: boundary.boundTime,
            boundID: boundary.boundID,
            afterTime: last.created,
            afterID: last.id,
          }),
        }
      : {}),
  }
})

/** Enumerate one child's invocation facts in durable admission order. */
export const invocations = Effect.fn("SessionTaskView.invocations")(function* (
  database: Database.Interface,
  input: {
    parentSessionID: SessionSchema.ID
    childSessionID: SessionSchema.ID
    cursor?: string
    limit?: number
    includeResults?: boolean
  },
) {
  const db = database.db
  const child = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(and(eq(SessionTable.id, input.childSessionID), eq(SessionTable.parent_id, input.parentSessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!child) return yield* Effect.fail(new TargetUnavailable())
  const cursor = yield* decodeCursor(input.cursor, "invocations", input.parentSessionID, input.childSessionID)
  const position = sql<number>`${SessionTaskTable}.rowid`
  const boundary =
    cursor ??
    (yield* db
      .select({
        upper: sql<number>`coalesce(max(${position}), 0)`,
        boundTime: sql<number>`coalesce(max(${SessionTaskTable.time_created}), 0)`,
        boundID: sql<string>`coalesce(max(${SessionTaskTable.input_id}), '')`,
      })
      .from(SessionTaskTable)
      .where(
        and(
          eq(SessionTaskTable.child_session_id, child.id),
          eq(SessionTaskTable.parent_session_id, input.parentSessionID),
        ),
      )
      .get()
      .pipe(Effect.orDie))!
  const limit = pageLimit(input.limit)
  const rows = yield* db
    .select({
      inputID: SessionTaskTable.input_id,
      created: SessionTaskTable.time_created,
      parentMessageID: SessionTaskTable.parent_message_id,
      callID: SessionTaskTable.call_id,
    })
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, child.id),
        eq(SessionTaskTable.parent_session_id, input.parentSessionID),
        lte(position, boundary.upper),
        lte(SessionTaskTable.time_created, boundary.boundTime),
        sql`${SessionTaskTable.input_id} <= ${boundary.boundID}`,
        cursor
          ? or(
              gt(SessionTaskTable.time_created, cursor.afterTime),
              and(eq(SessionTaskTable.time_created, cursor.afterTime), gt(SessionTaskTable.input_id, cursor.afterID)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: yield* Effect.forEach(page, (row) =>
      read(database, {
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
        invocation: {
          parent_session_id: input.parentSessionID,
          parent_message_id: row.parentMessageID,
          call_id: row.callID,
        },
        includeResults: input.includeResults,
      }),
    ),
    ...(rows.length > limit && last
      ? {
          next: encodeCursor({
            version: 1,
            kind: "invocations",
            parent: input.parentSessionID,
            child: child.id,
            upper: boundary.upper,
            boundTime: boundary.boundTime,
            boundID: boundary.boundID,
            afterTime: last.created,
            afterID: last.inputID,
          }),
        }
      : {}),
  }
})

/** A read is passive: it never wakes a Session or repairs an execution owner. */
export const read = Effect.fn("SessionTaskView.read")(function* (
  database: Database.Interface,
  input: {
    parentSessionID: SessionSchema.ID
    childSessionID: SessionSchema.ID
    invocation?: TaskSchema.Target["invocation"]
    includeResults?: boolean
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
  const latest = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, child.id),
        eq(SessionTaskTable.parent_session_id, input.parentSessionID),
      ),
    )
    .orderBy(desc(SessionTaskTable.time_created), desc(SessionTaskTable.input_id))
    .limit(1)
    .get()
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
    : latest
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
  const root_active = yield* db
    .select({ value: sql<number>`count(*)` })
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.root_session_id, row.root_session_id),
        or(eq(SessionTaskTable.state, "admitted"), eq(SessionTaskTable.state, "active")),
        eq(SessionTaskTable.abandoned_unknown, false),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  const root_pending = yield* db
    .select({ value: sql<number>`count(*)` })
    .from(SessionTaskTable)
    .where(and(eq(SessionTaskTable.root_session_id, row.root_session_id), eq(SessionTaskTable.state, "queued")))
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
  const active = yield* db
    .select()
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, child.id),
        or(eq(SessionTaskTable.state, "active"), eq(SessionTaskTable.state, "admitted")),
      ),
    )
    .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const activeObserved = active && observed?.owner_generation === active.owner_generation
  const resultSummary =
    input.includeResults && row.result_message_id
      ? yield* db
          .select({ text: sql<string>`substr(json_extract(${PartTable.data}, '$.text'), 1, 2049)` })
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, child.id),
              sql`${PartTable.message_id} = ${row.result_message_id}`,
              sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
            ),
          )
          .orderBy(asc(PartTable.id))
          .limit(9)
          .all()
          .pipe(Effect.orDie)
      : []
  const resultText = resultSummary
    .slice(0, 8)
    .map((part) => part.text)
    .join("\n")
  const resultBytes = Buffer.from(resultText, "utf8")
  const summary =
    resultBytes.length <= 2048
      ? resultText
      : (Array.from({ length: 4 }, (_, index) => 2048 - index)
          .map((length) => {
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(resultBytes.subarray(0, length))
            } catch {
              return undefined
            }
          })
          .find((value) => value !== undefined) ?? "")
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
            : ("unknown" as const)
          : ("unknown" as const),
    eligibility:
      row.state === "queued"
        ? active && !activeObserved
          ? ("frozen" as const)
          : ("eligible" as const)
        : ("none" as const),
    cancellation: "none" as const,
    lifecycle_source: "durable" as const,
    input_id: row.input_id,
    disposition: row.abandoned_unknown ? ("abandoned_unknown" as const) : ("none" as const),
    owner_safety:
      row.state === "settled"
        ? ("not_required" as const)
        : live
          ? ("confirmed_local_lease" as const)
          : ("unknown" as const),
    root_quota: {
      active_used: root_active?.value ?? 0,
      active_limit: SessionTask.ACTIVE_LIMIT,
      pending_used: root_pending?.value ?? 0,
      pending_limit: SessionTask.ROOT_PENDING_LIMIT,
    },
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
    ...(row.result_message_id
      ? {
          result: {
            message_id: row.result_message_id,
            ...(input.includeResults && summary ? { summary } : {}),
            truncated: Boolean(input.includeResults && (resultSummary.length > 8 || resultBytes.length > 2048)),
          },
        }
      : {}),
  }
  return view
})

/** Pending interaction requests are live owner evidence only when their tool message belongs to this invocation. */
export const withLivePhase = Effect.fn("SessionTaskView.withLivePhase")(function* (
  database: Database.Interface,
  view: TaskSchema.View,
  pending: {
    permissions: readonly { sessionID: string; source?: { messageID: string; callID: string } }[]
    questions: readonly { sessionID: string; tool?: { messageID: string; callID: string } }[]
  },
) {
  if (view.runtime !== "observed" || view.lifecycle !== "active" || !view.input_id) return view
  const matches = (sessionID: string, messageID?: string, callID?: string) =>
    sessionID === view.target.task_id && Boolean(messageID && callID)
  const sources = [
    ...pending.permissions
      .filter((request) => matches(request.sessionID, request.source?.messageID, request.source?.callID))
      .map((request) => ({
        phase: "permission" as const,
        messageID: request.source!.messageID,
        callID: request.source!.callID,
      })),
    ...pending.questions
      .filter((request) => matches(request.sessionID, request.tool?.messageID, request.tool?.callID))
      .map((request) => ({
        phase: "question" as const,
        messageID: request.tool!.messageID,
        callID: request.tool!.callID,
      })),
  ]
  if (!sources.length) return view
  const tools = yield* database.db
    .select({ messageID: MessageTable.id, callID: sql<string>`json_extract(${PartTable.data}, '$.callID')` })
    .from(PartTable)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    .where(
      and(
        eq(PartTable.session_id, view.target.task_id),
        eq(MessageTable.session_id, view.target.task_id),
        inArray(
          MessageTable.id,
          sources.map((source) => SessionV1.MessageID.make(source.messageID)),
        ),
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.parentID') = ${view.input_id}`,
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const owned = new Set<string>(tools.map((tool) => `${tool.messageID}\u0000${tool.callID}`))
  const phase = sources.find((source) => owned.has(`${source.messageID}\u0000${source.callID}`))?.phase
  return phase ? { ...view, phase } : view
})

/** HTTP and model status reads use the same actual Location-owned interaction services. */
export const withObservedPhase = Effect.fn("SessionTaskView.withObservedPhase")(function* (
  database: Database.Interface,
  view: TaskSchema.View,
  locations: LocationServiceMap.Interface,
) {
  if (view.runtime !== "observed") return view
  const child = yield* database.db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, view.target.task_id))
    .get()
    .pipe(Effect.orDie)
  if (!child) return view
  return yield* Effect.gen(function* () {
    const permission = yield* PermissionV2.Service
    const question = yield* QuestionV2.Service
    return yield* withLivePhase(database, view, {
      permissions: yield* permission.forSession(view.target.task_id),
      questions: yield* question.list(),
    })
  }).pipe(
    Effect.provide(locations.get(SessionPolicyStore.locationFromRow(child))),
    Effect.catch(() => Effect.succeed(view)),
  )
})

import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import type { Revert } from "@opencode-ai/schema/revert"
import type { Location } from "../location"
import type { ApprovalMode } from "@opencode-ai/schema/approval-mode"
import type { ModelContext } from "@opencode-ai/schema/model-context"
import type { Skill } from "@opencode-ai/schema/skill"
import type { SessionPolicy } from "@opencode-ai/schema/session-policy"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    target: text({ mode: "json" }).$type<Location.Target>(),
    last_known_target_name: text(),
    portable_target_label: text(),
    sync_space_id: text(),
    location_revision: integer().notNull().default(0),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    approval_mode: text().$type<ApprovalMode.Mode>().notNull().default("normal"),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    permission_revision: integer().notNull().default(0),
    permission_basis_revision: integer().notNull().default(0),
    permission_boundary: text({ mode: "json" }).$type<SessionPolicy.Boundary>(),
    subagent_access: text({ mode: "json" }).$type<SessionV1.SubagentAccess>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    index("session_sync_space_idx").on(table.sync_space_id, table.time_updated),
  ],
)

/** A route grants only the capabilities recorded here; parent_id is historical provenance. */
export const SessionPeerRouteTable = sqliteTable(
  "session_peer_route",
  {
    source_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    alias: text().notNull(),
    target_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    origin_kind: text().$type<"spawn" | "user_message" | "user_selection" | "legacy">().notNull(),
    origin_id: text().notNull(),
    can_inspect: integer({ mode: "boolean" }).notNull().default(true),
    can_interact: integer({ mode: "boolean" }).notNull().default(true),
    can_interrupt: integer({ mode: "boolean" }).notNull().default(false),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source_session_id, table.alias] }),
    index("session_peer_route_target_idx").on(table.target_session_id),
  ],
)

/** Only an authenticated user entry point can record this provenance. */
export const SessionPeerUserMessageTable = sqliteTable(
  "session_peer_user_message",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.message_id] })],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<(typeof Prompt)["Encoded"]>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    origin: text({ mode: "json" }).$type<{
      kind: "delegation_result"
      invocationInputID: string
      terminalEventID: string
      version: 1
    }>(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

/** Task invocation facts; execution-owner observations are deliberately not stored here. */
export const SessionTaskTable = sqliteTable(
  "session_task",
  {
    input_id: text().primaryKey(),
    root_session_id: text().notNull(),
    parent_session_id: text().notNull(),
    parent_message_id: text().notNull(),
    call_id: text().notNull(),
    prompt_digest: text().notNull(),
    child_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    description: text().notNull(),
    agent_id: text().notNull(),
    location_revision: integer().notNull(),
    state: text().$type<"queued" | "admitted" | "active" | "settled">().notNull(),
    /** Durable execution eligibility; a frozen pending input needs explicit disposition. */
    eligibility: text().$type<"eligible" | "frozen" | "cancelled">().notNull().default("eligible"),
    disposition_operation_id: text(),
    disposition_actor_id: text(),
    disposition_time: integer(),
    backend: text().$type<"legacy" | "v2">().notNull(),
    background: integer({ mode: "boolean" }).notNull().default(false),
    outcome: text().$type<"completed" | "failed" | "cancelled">(),
    result_message_id: text(),
    terminal_event_id: text(),
    abandoned_unknown: integer({ mode: "boolean" }).notNull().default(false),
    archive_operation_id: text(),
    archive_actor_id: text(),
    archive_time: integer(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_settled: integer(),
    /** Local observation only; never copied into a durable sync event. */
    owner_pid: integer(),
    owner_start: text(),
    owner_generation: text(),
    owner_observed_at: integer(),
  },
  (table) => [
    uniqueIndex("session_task_parent_call_idx").on(table.parent_message_id, table.call_id),
    uniqueIndex("session_task_archive_operation_idx").on(table.archive_operation_id),
    uniqueIndex("session_task_disposition_operation_idx").on(table.disposition_operation_id),
    index("session_task_root_state_idx").on(table.root_session_id, table.state, table.time_created),
    index("session_task_child_state_idx").on(table.child_session_id, table.state, table.time_created),
  ],
)

/** Local projection barrier for deleted Task roots and parents, including sync control tombstones. */
export const SessionTaskDeletionTable = sqliteTable("session_task_deletion", {
  session_id: text().primaryKey(),
})

/** Parent-side projection of a child terminal; deleted with its parent Session. */
export const SessionTaskResultTable = sqliteTable("session_task_result", {
  invocation_input_id: text().primaryKey(),
  root_session_id: text().notNull(),
  parent_session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  child_session_id: text().notNull(),
  terminal_event_id: text().notNull(),
  outcome: text().$type<"completed" | "failed" | "cancelled">().notNull(),
  result_message_id: text(),
  summary: text().notNull(),
  notification_input_id: text().notNull().unique(),
  notify: integer({ mode: "boolean" }).notNull(),
  version: integer().notNull(),
})

export const SessionTaskWakeRevocationTable = sqliteTable("session_task_wake_revocation", {
  invocation_input_id: text().primaryKey(),
  root_session_id: text().notNull(),
  parent_session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  stop_event_id: text().notNull(),
})

/** Durable child-inbox receipt for one steer of one exact Task invocation. */
export const SessionTaskSteerTable = sqliteTable(
  "session_task_steer",
  {
    input_id: text()
      .primaryKey()
      .references(() => SessionInputTable.id, { onDelete: "cascade" }),
    invocation_input_id: text()
      .notNull()
      .references(() => SessionTaskTable.input_id, { onDelete: "cascade" }),
    operation_id: text().notNull(),
    prompt_digest: text().notNull(),
    state: text().$type<"admitted" | "promoted" | "not_delivered">().notNull(),
    reason: text().$type<"settled" | "owner_lost">(),
    time_created: integer().notNull(),
    time_promoted: integer(),
    time_not_delivered: integer(),
  },
  (table) => [
    uniqueIndex("session_task_steer_operation_idx").on(table.operation_id),
    index("session_task_steer_invocation_idx").on(table.invocation_input_id, table.time_created),
  ],
)

/** Exact, replayable management operation receipts for pending Task inputs. */
export const SessionTaskOperationTable = sqliteTable(
  "session_task_operation",
  {
    operation_id: text().primaryKey(),
    input_id: text()
      .notNull()
      .references(() => SessionTaskTable.input_id, { onDelete: "cascade" }),
    actor_kind: text().$type<"user" | "parent">().notNull(),
    actor_id: text().notNull(),
    disposition: text().$type<"resume_pending" | "cancel_pending">().notNull(),
    capacity_state: text().$type<"available" | "capacity_unavailable" | "not_applicable">().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_task_operation_input_idx").on(table.input_id, table.time_created)],
)

/** Projection of a durable fixed-scope stop event; retry never takes a new snapshot. */
export const SessionTaskStopTable = sqliteTable("session_task_stop", {
  operation_id: text().primaryKey(),
  root_session_id: text().notNull(),
  parent_session_id: text().notNull(),
  child_session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  actor_kind: text().$type<"user" | "parent">().notNull(),
  actor_id: text().notNull(),
  intent: text().$type<"interrupt" | "stop">().notNull(),
  members: text({ mode: "json" }).$type<readonly { inputID: string; state: "active" | "pending" }[]>().notNull(),
  time_created: integer().notNull(),
})

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
  generation: integer().notNull().default(1),
  reason: text().notNull().default("legacy-backfill").$type<ModelContext.GenerationReason>(),
  location_revision: integer().notNull().default(0),
  digest: text().notNull().default(""),
})

export const SessionSkillCatalogTable = sqliteTable("session_skill_catalog", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  catalog: text({ mode: "json" }).notNull().$type<Skill.AdmittedCatalog>(),
  guidance: text(),
})

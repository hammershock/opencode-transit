import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import type { SessionSchema } from "./schema"

/** Database-local controller identity; never part of Session export or sync. */
export const SessionPolicyDeviceTable = sqliteTable("session_policy_device", {
  id: integer().primaryKey(),
  device_id: text().notNull(),
})

export const SessionPolicyReviewTable = sqliteTable(
  "session_policy_review",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    device_id: text().notNull(),
    request_id: text().notNull(),
    seq: integer().notNull(),
    data: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.device_id, table.request_id] })],
)

/** Operational receipts are written only by the local commit hook, never replayed or exported. */
export const SessionPolicyActivationTable = sqliteTable(
  "session_policy_activation",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    device_id: text().notNull(),
    request_id: text().notNull(),
    location: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.device_id, table.request_id] })],
)

export * as RevertHistory from "./revert-history"

import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { MessageTable, SessionMessageTable } from "./sql"

/** The same user-turn ordering used by the combined compatibility transcript. */
export const read = Effect.fn("RevertHistory.read")(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const legacy = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  const canonical = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const users = new Map(legacy.filter((row) => row.data.role === "user").map((row) => [String(row.id), row]))
  let parent: (typeof canonical)[number] | undefined
  const current = canonical.map((row) => {
    if (row.type === "user") parent = row
    return { kind: "canonical" as const, row, turn: row.type === "assistant" ? (parent ?? row) : row }
  })
  // Keep the current protocol's durable ordering when no compatibility timeline is involved.
  if (!legacy.length) return current
  const ids = new Set(canonical.map((row) => String(row.id)))
  return [
    ...current,
    ...legacy
      .filter((row) => !ids.has(row.id))
      .map((row) => ({
        kind: "legacy" as const,
        row,
        turn:
          row.data.role === "assistant" && "parentID" in row.data && typeof row.data.parentID === "string"
            ? (users.get(row.data.parentID) ?? row)
            : row,
      })),
  ].toSorted(
    (a, b) =>
      a.turn.time_created - b.turn.time_created ||
      a.turn.id.localeCompare(b.turn.id) ||
      Number(a.row.id !== a.turn.id) - Number(b.row.id !== b.turn.id) ||
      a.row.time_created - b.row.time_created ||
      a.row.id.localeCompare(b.row.id),
  )
})

export const boundary = Effect.fn("RevertHistory.boundary")(function* (sessionID: SessionSchema.ID, messageID: string) {
  const messages = yield* read(sessionID)
  const index = messages.findIndex((item) => item.row.id === messageID)
  const message = messages[index]
  return message ? { message, messages: messages.slice(index) } : undefined
})

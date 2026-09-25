export * as SessionAgentWaitOwner from "./agent-wait-owner"

import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionAgentWaitTable } from "./sql"
import { SessionSchema } from "./schema"

const active = new Set<string>()
const gates = KeyedMutex.makeUnsafe<string>()
export const withReceiver = gates.withLock

/** The durable row records history; only this process-local owner can receive a live event. */
export function start(id: string) {
  active.add(id)
}

export function finish(id: string) {
  active.delete(id)
}

export const current = Effect.fn("SessionAgentWaitOwner.current")(function* (input: {
  db: Database.Interface["db"]
  receiver: SessionSchema.ID
  subject: SessionSchema.ID
}) {
  const rows = yield* input.db
    .select()
    .from(SessionAgentWaitTable)
    .where(and(eq(SessionAgentWaitTable.session_id, input.receiver), eq(SessionAgentWaitTable.state, "active")))
    .orderBy(asc(SessionAgentWaitTable.time_created), asc(SessionAgentWaitTable.call_id))
    .all()
    .pipe(Effect.orDie)
  return rows.find((row) => active.has(row.id) && row.targets.includes(input.subject))?.call_id
})

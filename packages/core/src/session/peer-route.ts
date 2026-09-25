export * as SessionPeerRoute from "./peer-route"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionPeerRouteTable,
  SessionPeerUserMessageTable,
  SessionTable,
} from "./sql"

export class InvalidAlias extends Error {
  readonly code = "invalid_agent_alias"
  constructor() {
    super(
      "Agent alias must be an absolute path of ASCII letters, digits, underscores or hyphens, at most 128 characters",
    )
  }
}

export class UnknownOrForbidden extends Error {
  readonly code = "agent_unknown_or_forbidden"
  constructor() {
    super("agent_unknown_or_forbidden")
  }
}

export class AliasConflict extends Error {
  readonly code = "agent_alias_conflict"
  constructor() {
    super("agent_alias_conflict")
  }
}

export type Capability = "inspect" | "interact" | "interrupt"
export type Origin =
  | { kind: "spawn" | "legacy"; id: string }
  | { kind: "user_message"; id: string }
  | { kind: "user_selection"; id: string }

export function validAlias(alias: string) {
  return alias.length <= 128 && alias !== "/root" && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(alias)
}

/** A route is a durable, directed capability; the historical parent edge never authorizes lookup. */
export const bind = Effect.fn("SessionPeerRoute.bind")(function* (input: {
  sourceSessionID: SessionSchema.ID
  targetSessionID: SessionSchema.ID
  alias: string
  origin: Origin
}) {
  if (!validAlias(input.alias)) return yield* Effect.fail(new InvalidAlias())
  if (input.sourceSessionID === input.targetSessionID) return yield* Effect.fail(new UnknownOrForbidden())
  if (input.origin.kind === "user_selection") return yield* Effect.fail(new UnknownOrForbidden())
  const db = (yield* Database.Service).db
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const sessions = yield* tx
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sourceSessionID))
        .all()
      if (sessions.length !== 1) return yield* Effect.fail(new UnknownOrForbidden())
      const target = yield* tx
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.targetSessionID))
        .get()
      if (!target) return yield* Effect.fail(new UnknownOrForbidden())
      if (input.origin.kind === "user_message") {
        const provenance = yield* tx
          .select({ message_id: SessionPeerUserMessageTable.message_id })
          .from(SessionPeerUserMessageTable)
          .where(
            and(
              eq(SessionPeerUserMessageTable.session_id, input.sourceSessionID),
              eq(SessionPeerUserMessageTable.message_id, input.origin.id),
            ),
          )
          .get()
        if (!provenance) return yield* Effect.fail(new UnknownOrForbidden())
        const projected = yield* tx
          .select({ type: SessionMessageTable.type, data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.id, input.origin.id as typeof SessionMessageTable.id._.data),
              eq(SessionMessageTable.session_id, input.sourceSessionID),
            ),
          )
          .get()
        const admitted = yield* tx
          .select({ prompt: SessionInputTable.prompt, origin: SessionInputTable.origin })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.id, input.origin.id as typeof SessionInputTable.id._.data),
              eq(SessionInputTable.session_id, input.sourceSessionID),
            ),
          )
          .get()
        const legacy = yield* tx
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.id, input.origin.id as typeof MessageTable.id._.data),
              eq(MessageTable.session_id, input.sourceSessionID),
            ),
          )
          .get()
        const parts =
          legacy?.data.role === "user"
            ? yield* tx
                .select({ data: PartTable.data })
                .from(PartTable)
                .where(eq(PartTable.message_id, input.origin.id as typeof PartTable.message_id._.data))
                .all()
            : []
        const text = projected
          ? projected.type === "user" &&
            "text" in projected.data &&
            typeof projected.data.text === "string" &&
            !("origin" in projected.data)
            ? projected.data.text
            : ""
          : admitted
            ? !admitted.origin
              ? admitted.prompt.text
              : ""
            : legacy?.data.role === "user"
                ? parts
                    .flatMap((part) =>
                      part.data.type === "text" &&
                      "text" in part.data &&
                      typeof part.data.text === "string" &&
                      !("synthetic" in part.data && part.data.synthetic) &&
                      !("ignored" in part.data && part.data.ignored)
                        ? [part.data.text]
                        : [],
                    )
                    .join("\n")
                : ""
        if (!text.match(/[A-Za-z0-9_]+/g)?.includes(input.targetSessionID))
          return yield* Effect.fail(new UnknownOrForbidden())
      }
      const existing = yield* tx
        .select()
        .from(SessionPeerRouteTable)
        .where(
          and(
            eq(SessionPeerRouteTable.source_session_id, input.sourceSessionID),
            eq(SessionPeerRouteTable.alias, input.alias),
          ),
        )
        .get()
      if (existing) {
        if (existing.target_session_id !== input.targetSessionID) return yield* Effect.fail(new AliasConflict())
        return existing
      }
      yield* tx
        .insert(SessionPeerRouteTable)
        .values({
          source_session_id: input.sourceSessionID,
          target_session_id: input.targetSessionID,
          alias: input.alias,
          origin_kind: input.origin.kind,
          origin_id: input.origin.id,
          can_interrupt: input.origin.kind === "spawn",
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
      const bound = yield* tx
        .select()
        .from(SessionPeerRouteTable)
        .where(
          and(
            eq(SessionPeerRouteTable.source_session_id, input.sourceSessionID),
            eq(SessionPeerRouteTable.alias, input.alias),
          ),
        )
        .get()
      if (bound?.target_session_id !== input.targetSessionID) return yield* Effect.fail(new AliasConflict())
      return bound
    }),
    { behavior: "immediate" },
  )
})

/** Called only by the authenticated direct-user prompt entry point before prompt admission. */
export const markUserMessage = Effect.fn("SessionPeerRoute.markUserMessage")(function* (input: {
  sessionID: SessionSchema.ID
  messageID: string
}) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(SessionPeerUserMessageTable)
    .values({
      session_id: input.sessionID,
      message_id: input.messageID,
      time_created: Date.now(),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const resolve = Effect.fn("SessionPeerRoute.resolve")(function* (input: {
  sourceSessionID: SessionSchema.ID
  alias: string
  capability: Capability
}) {
  const db = (yield* Database.Service).db
  yield* backfillLegacy(db, input.sourceSessionID)
  const row = yield* db
    .select()
    .from(SessionPeerRouteTable)
    .where(
      and(
        eq(SessionPeerRouteTable.source_session_id, input.sourceSessionID),
        eq(SessionPeerRouteTable.alias, input.alias),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row || !row[`can_${input.capability}`]) return yield* Effect.fail(new UnknownOrForbidden())
  return row
})

export const list = Effect.fn("SessionPeerRoute.list")(function* (sourceSessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  yield* backfillLegacy(db, sourceSessionID)
  return yield* db
    .select()
    .from(SessionPeerRouteTable)
    .where(eq(SessionPeerRouteTable.source_session_id, sourceSessionID))
    .all()
    .pipe(Effect.orDie)
})

/** Old parent provenance is imported once as a visible contact without changing either Session. */
const backfillLegacy = Effect.fn("SessionPeerRoute.backfillLegacy")(function* (
  db: Database.Interface["db"],
  sourceSessionID: SessionSchema.ID,
) {
  const children = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, sourceSessionID))
    .all()
    .pipe(Effect.orDie)
  const routed = yield* db
    .select({ target: SessionPeerRouteTable.target_session_id })
    .from(SessionPeerRouteTable)
    .where(eq(SessionPeerRouteTable.source_session_id, sourceSessionID))
    .all()
    .pipe(Effect.orDie)
  const known = new Set(routed.map((route) => route.target))
  yield* Effect.forEach(
    children.filter((child) => !known.has(child.id)),
    (child) =>
      db
        .insert(SessionPeerRouteTable)
        .values({
          source_session_id: sourceSessionID,
          target_session_id: child.id,
          alias: `/root/legacy_${child.id}`,
          origin_kind: "legacy",
          origin_id: child.id,
          can_interrupt: true,
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    { discard: true },
  )
})

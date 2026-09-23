export * as SessionPolicyStore from "./policy"

import { and, desc, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { Permission } from "@opencode-ai/schema/permission"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Location } from "../location"
import { Hash } from "../util/hash"
import type { SessionLocationMutation } from "./location-mutation"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionPolicyActivationTable, SessionPolicyReviewTable } from "./policy.sql"
import { AbsolutePath } from "../schema"

export class Failure extends Schema.TaggedErrorClass<Failure>()("SessionPolicy.Failure", {
  kind: Schema.Literals(["not-found", "unavailable", "conflict", "invalid-review"]),
  message: Schema.String,
}) {}

// Explicit unsafe-compatibility boundary: only the legacy rule shape is accepted;
// current policy contracts use the exact canonical Permission.Rule schema.
const LegacyRules = Schema.Array(
  Schema.Struct({
    permission: Schema.String,
    pattern: Schema.String,
    action: Permission.Effect,
  }),
)

const ActivationLocation = Schema.Struct({
  ...Location.Ref.fields,
  // These receipts are new; a missing target is corruption, not legacy local placement.
  target: Location.Target,
})

export function legacyRules(value: unknown): Permission.Ruleset {
  const decoded = Schema.decodeUnknownOption(LegacyRules)(value ?? [])
  if (Option.isNone(decoded)) throw new Failure({ kind: "unavailable", message: "Legacy policy is unreadable" })
  return decoded.value.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }))
}

export function digest(rules: Permission.Ruleset) {
  return Hash.sha256(JSON.stringify(rules.map((rule) => [rule.action, rule.resource, rule.effect])))
}

export function locationKey(location: Location.Ref) {
  return JSON.stringify([
    location.target.type === "rexd" ? location.target.targetID : "local",
    location.directory,
    location.workspaceID ?? null,
  ])
}

function decodeReview(data: unknown) {
  const decoded = Schema.decodeUnknownOption(SessionPolicy.Review)(data)
  if (Option.isNone(decoded)) throw new Failure({ kind: "unavailable", message: "Policy review is unreadable" })
  const review = decoded.value
  if (
    review.revision !== review.previousRevision + 1 ||
    review.legacyDigest !== digest(review.baseline) ||
    review.accepted.length !== review.baseline.filter((rule) => rule.effect === "allow").length
  )
    throw new Failure({ kind: "unavailable", message: "Policy review is inconsistent" })
  return review
}

function decodeLocation(data: unknown) {
  const decoded = Schema.decodeUnknownOption(ActivationLocation)(data)
  if (Option.isNone(decoded)) throw new Failure({ kind: "unavailable", message: "Policy activation is unreadable" })
  return decoded.value
}

export interface View {
  readonly status: "current" | "pending" | "reviewed"
  readonly revision: number
  readonly legacyDigest: string
  readonly location: Location.Ref
  readonly locationRevision: number
  readonly baseline: Permission.Ruleset
  readonly rules: Permission.Ruleset
  readonly review?: SessionPolicy.Review
}

export interface ReviewInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly expectedRevision: number
  readonly legacyDigest: string
  readonly locationRevision: number
  readonly location: Location.Ref
  readonly accepted: readonly boolean[]
}

/** Trusted composition inputs, not an HTTP/tool payload. No executor consumes this passive foundation yet. */
export function make(input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly mutation: SessionLocationMutation.Interface
  readonly deviceID: string
  readonly resolveLocation: (sessionID: SessionSchema.ID) => Effect.Effect<Location.Ref, unknown>
}) {
  if (!input.deviceID.trim()) throw new Error("A stable local policy device identity is required")
  const db = input.db
  const row = Effect.fn("SessionPolicy.row")(function* (sessionID: SessionSchema.ID) {
    const stored = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!stored) return yield* new Failure({ kind: "not-found", message: "Session does not exist" })
    return stored
  })
  const receipt = Effect.fn("SessionPolicy.receipt")(function* (sessionID: SessionSchema.ID, requestID: string) {
    return yield* db
      .select()
      .from(SessionPolicyActivationTable)
      .where(
        and(
          eq(SessionPolicyActivationTable.session_id, sessionID),
          eq(SessionPolicyActivationTable.device_id, input.deviceID),
          eq(SessionPolicyActivationTable.request_id, requestID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
  })
  const resolveLocation = (sessionID: SessionSchema.ID) =>
    input
      .resolveLocation(sessionID)
      .pipe(Effect.mapError(() => new Failure({ kind: "unavailable", message: "Session Location is unresolved" })))

  const inspect = Effect.fn("SessionPolicy.inspect")(function* (
    sessionID: SessionSchema.ID,
  ): Effect.fn.Return<View, Failure> {
    const stored = yield* row(sessionID)
    const location = yield* resolveLocation(sessionID)
    const baseline = legacyRules(stored.permission)
    const latest = yield* db
      .select()
      .from(SessionPolicyReviewTable)
      .where(
        and(
          eq(SessionPolicyReviewTable.session_id, sessionID),
          eq(SessionPolicyReviewTable.device_id, input.deviceID),
        ),
      )
      .orderBy(desc(SessionPolicyReviewTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const review = latest ? decodeReview(latest.data) : undefined
    if (
      review &&
      latest &&
      (review.sessionID !== sessionID || review.deviceID !== latest.device_id || review.requestID !== latest.request_id)
    )
      return yield* new Failure({ kind: "unavailable", message: "Policy review identity is inconsistent" })
    const activation = review ? yield* receipt(sessionID, review.requestID) : undefined
    const bound = activation ? decodeLocation(activation.location) : undefined
    const valid =
      review &&
      bound &&
      review.sessionID === sessionID &&
      review.basisRevision !== undefined &&
      review.basisRevision === stored.permission_basis_revision &&
      review.legacyDigest === digest(baseline) &&
      review.locationRevision === stored.location_revision &&
      locationKey(bound) === locationKey(location)
    const allowed = new Set(
      valid ? baseline.filter((rule) => rule.effect === "allow").filter((_, index) => review.accepted[index]) : [],
    )
    return {
      status: valid ? "reviewed" : baseline.some((rule) => rule.effect === "allow") ? "pending" : "current",
      revision: stored.permission_revision,
      legacyDigest: digest(baseline),
      location,
      locationRevision: stored.location_revision,
      baseline,
      rules: baseline.filter((rule) => rule.effect !== "allow" || allowed.has(rule)),
      ...(review ? { review } : {}),
    }
  })

  const existing = Effect.fn("SessionPolicy.existing")(function* (request: ReviewInput) {
    const stored = yield* db
      .select()
      .from(SessionPolicyReviewTable)
      .where(
        and(
          eq(SessionPolicyReviewTable.session_id, request.sessionID),
          eq(SessionPolicyReviewTable.device_id, input.deviceID),
          eq(SessionPolicyReviewTable.request_id, request.requestID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!stored) return
    const review = decodeReview(stored.data)
    if (review.deviceID !== input.deviceID || review.requestID !== request.requestID)
      return yield* new Failure({ kind: "unavailable", message: "Policy review identity is inconsistent" })
    const activation = yield* receipt(request.sessionID, request.requestID)
    if (
      !activation ||
      review.sessionID !== request.sessionID ||
      review.previousRevision !== request.expectedRevision ||
      review.legacyDigest !== request.legacyDigest ||
      review.locationRevision !== request.locationRevision ||
      JSON.stringify(review.accepted) !== JSON.stringify(request.accepted) ||
      locationKey(decodeLocation(activation.location)) !== locationKey(request.location)
    )
      return yield* new Failure({ kind: "conflict", message: "Review request ID was already used for different input" })
    return review
  })

  const review = Effect.fn("SessionPolicy.review")(function* (request: ReviewInput) {
    if (!request.requestID.trim())
      return yield* new Failure({ kind: "invalid-review", message: "Review request ID is required" })
    const prior = yield* existing(request)
    if (prior) return prior
    const current = yield* inspect(request.sessionID)
    if (
      current.revision !== request.expectedRevision ||
      current.legacyDigest !== request.legacyDigest ||
      current.locationRevision !== request.locationRevision ||
      locationKey(current.location) !== locationKey(request.location)
    )
      return yield* new Failure({ kind: "conflict", message: "Session policy or Location changed" })
    if (
      request.accepted.length !== current.baseline.filter((rule) => rule.effect === "allow").length ||
      !request.accepted.every((value) => typeof value === "boolean")
    )
      return yield* new Failure({ kind: "invalid-review", message: "Every legacy allow needs one explicit decision" })
    const stored = yield* row(request.sessionID)
    const result = SessionPolicy.Review.make({
      version: 1,
      sessionID: request.sessionID,
      requestID: request.requestID,
      deviceID: input.deviceID,
      previousRevision: current.revision,
      revision: current.revision + 1,
      basisRevision: stored.permission_basis_revision,
      legacyDigest: current.legacyDigest,
      locationRevision: current.locationRevision,
      directory: current.location.directory,
      ...(stored.portable_target_label ? { portableTargetLabel: stored.portable_target_label } : {}),
      baseline: current.baseline,
      accepted: request.accepted,
    })
    return yield* input.events
      .publish(SessionPolicy.Reviewed, result, {
        commit: () =>
          Effect.gen(function* () {
            // Projectors run before this hook, in the same immediate transaction.
            // Another process may have changed the policy since the initial read.
            const latest = yield* row(request.sessionID).pipe(Effect.orDie)
            if (
              latest.permission_revision !== result.revision ||
              latest.permission_basis_revision !== result.basisRevision ||
              latest.location_revision !== result.locationRevision ||
              digest(legacyRules(latest.permission)) !== result.legacyDigest ||
              locationKey(locationFromRow(latest)) !== locationKey(locationFromRow(stored))
            )
              return yield* Effect.die(
                new Failure({ kind: "conflict", message: "Session changed before review commit" }),
              )
            yield* db
              .insert(SessionPolicyActivationTable)
              .values({
                session_id: request.sessionID,
                device_id: input.deviceID,
                request_id: request.requestID,
                location: current.location,
              })
              .run()
              .pipe(Effect.orDie)
          }),
      })
      .pipe(
        Effect.as(result),
        Effect.catchDefect((cause) =>
          Effect.gen(function* () {
            // A competing identical command may have committed while this one read.
            const committed = yield* existing(request)
            if (committed) return committed
            return yield* Effect.die(cause)
          }),
        ),
      )
  })

  const errors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catchDefect((cause) => (cause instanceof Failure ? Effect.fail(cause) : Effect.die(cause))))
  return {
    // Read-only composition also runs inside prompt admission/rebind locks.
    // Review still owns serialization and rechecks every token at commit.
    inspect: (sessionID: SessionSchema.ID) => errors(inspect(sessionID)),
    review: (request: ReviewInput) => input.mutation.withLock(errors(review(request))),
  }
}

export function locationFromRow(row: typeof SessionTable.$inferSelect) {
  return Location.Ref.make({
    directory: AbsolutePath.make(row.directory),
    target: row.target ?? { type: "local" },
    ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
  })
}

/** Called only by SessionProjector inside EventV2's durable transaction. Never creates activation receipts. */
export function project(db: Database.Interface["db"], event: EventV2.Payload<typeof SessionPolicy.Reviewed>) {
  return Effect.gen(function* () {
    const review = decodeReview(event.data)
    if (!event.durable)
      return yield* Effect.die(new Failure({ kind: "unavailable", message: "Policy review must be durable" }))
    const inserted = yield* db
      .insert(SessionPolicyReviewTable)
      .values({
        session_id: review.sessionID,
        device_id: review.deviceID,
        request_id: review.requestID,
        seq: event.durable.seq,
        data: review,
      })
      .onConflictDoNothing()
      .returning({ requestID: SessionPolicyReviewTable.request_id })
      .get()
      .pipe(Effect.orDie)
    if (!inserted)
      return yield* Effect.die(new Failure({ kind: "conflict", message: "Duplicate policy review request" }))
    yield* db
      .update(SessionTable)
      .set({ permission_revision: sql`${SessionTable.permission_revision} + 1` })
      .where(eq(SessionTable.id, review.sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

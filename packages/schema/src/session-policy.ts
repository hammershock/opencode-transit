export * as SessionPolicy from "./session-policy"

import { Schema } from "effect"
import { Event } from "./event"
import { Permission } from "./permission"
import { SessionID } from "./session-id"
import { AbsolutePath, NonNegativeInt, optional } from "./schema"
import { Location } from "./location"

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "SessionPolicy.Digest",
})
export type Digest = typeof Digest.Type

export const RequestID = Schema.NonEmptyString.annotate({ identifier: "SessionPolicy.RequestID" })
export type RequestID = typeof RequestID.Type

/** Each ruleset is a separate deny ceiling; allows inside it are exceptions, not grants. */
export const Boundary = Schema.Array(Permission.Ruleset).annotate({ identifier: "SessionPolicy.Boundary" })
export type Boundary = typeof Boundary.Type

/** Durable evidence only. Actual target identity and activation remain device-local. */
export interface Review extends Schema.Schema.Type<typeof Review> {}
export const Review = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  requestID: RequestID,
  deviceID: Schema.NonEmptyString,
  previousRevision: NonNegativeInt,
  revision: NonNegativeInt,
  /** Underlying legacy-policy/placement epoch. Absent historical evidence is never activated. */
  basisRevision: optional(NonNegativeInt),
  legacyDigest: Digest,
  locationRevision: NonNegativeInt,
  directory: AbsolutePath,
  portableTargetLabel: optional(Schema.String),
  baseline: Permission.Ruleset,
  /** One accept/drop decision for each baseline allow, in baseline order. */
  accepted: Schema.Array(Schema.Boolean),
}).annotate({ identifier: "SessionPolicy.Review" })

// Current durable-internal event: sync/replay needs it, public Protocol does not
// advertise a policy-review workflow until its user-facing consumer is shipped.
export const Reviewed = Event.define({
  type: "session.policy.reviewed",
  durable: { aggregate: "sessionID", version: 1 },
  schema: Review.fields,
})

export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  status: Schema.Literals(["current", "pending", "reviewed"]),
  revision: NonNegativeInt,
  legacyDigest: Digest,
  location: Location.Ref,
  locationRevision: NonNegativeInt,
  baseline: Permission.Ruleset,
  rules: Permission.Ruleset,
  review: optional(Review),
}).annotate({ identifier: "SessionPolicy.View" })

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  requestID: RequestID,
  expectedRevision: NonNegativeInt,
  legacyDigest: Digest,
  locationRevision: NonNegativeInt,
  location: Location.Ref,
  accepted: Schema.Array(Schema.Boolean),
}).annotate({ identifier: "SessionPolicy.Request" })

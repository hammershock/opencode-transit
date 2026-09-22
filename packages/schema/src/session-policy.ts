export * as SessionPolicy from "./session-policy"

import { Schema } from "effect"
import { Event } from "./event"
import { Permission } from "./permission"
import { SessionID } from "./session-id"
import { AbsolutePath, NonNegativeInt, optional } from "./schema"

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "SessionPolicy.Digest",
})
export type Digest = typeof Digest.Type

export const RequestID = Schema.NonEmptyString.annotate({ identifier: "SessionPolicy.RequestID" })
export type RequestID = typeof RequestID.Type

/** Durable evidence only. Actual target identity and activation remain device-local. */
export interface Review extends Schema.Schema.Type<typeof Review> {}
export const Review = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  requestID: RequestID,
  deviceID: Schema.NonEmptyString,
  previousRevision: NonNegativeInt,
  revision: NonNegativeInt,
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

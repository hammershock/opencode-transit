export * as SessionTaskEvent from "./session-task-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

/** Only durable invocation facts belong in sync payloads; owner tokens stay local. */
export const Admission = Schema.Struct({
  inputID: Schema.String,
  rootSessionID: SessionID,
  parentSessionID: SessionID,
  parentMessageID: Schema.String,
  callID: Schema.String,
  promptDigest: Schema.String,
  childSessionID: SessionID,
  description: Schema.String,
  agentID: Schema.String,
  locationRevision: Schema.Int,
  backend: Schema.Literals(["legacy", "v2"]),
})
export type Admission = typeof Admission.Type

export const Admitted = Event.define({
  type: "session.task.admitted",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    admission: Admission,
    timestamp: Schema.Finite,
  },
})

export const Settled = Event.define({
  type: "session.task.settled",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    inputID: Schema.String,
    outcome: Schema.Literals(["completed", "failed", "cancelled"]),
    resultMessageID: Schema.optional(Schema.String),
    timestamp: Schema.Finite,
  },
})

export const Promoted = Event.define({
  type: "session.task.promoted",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    inputID: Schema.String,
    timestamp: Schema.Finite,
  },
})

export const ArchivedUnknown = Event.define({
  type: "session.task.archived-unknown",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    inputID: Schema.String,
    operationID: Schema.String,
    actorID: Schema.String,
    timestamp: Schema.Finite,
  },
})

export const Reconciled = Event.define({
  type: "session.task.reconciled",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    inputID: Schema.String,
    operationID: Schema.String,
    actorKind: Schema.Literals(["user", "parent"]),
    actorID: Schema.String,
    disposition: Schema.Literals(["resume_pending", "cancel_pending"]),
    capacityState: Schema.Literals(["available", "capacity_unavailable", "not_applicable"]),
    timestamp: Schema.Finite,
  },
})

export const Stopped = Event.define({
  type: "session.task.stopped",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    rootSessionID: SessionID,
    parentSessionID: SessionID,
    operationID: Schema.String,
    intent: Schema.Literals(["interrupt", "stop"]),
    actorKind: Schema.Literals(["user", "parent"]),
    actorID: Schema.String,
    members: Schema.Array(Schema.Struct({ inputID: Schema.String, state: Schema.Literals(["active", "pending"]) })),
    timestamp: Schema.Finite,
  },
})

export const Definitions = Event.inventory(Admitted, Promoted, Settled, ArchivedUnknown, Reconciled, Stopped)

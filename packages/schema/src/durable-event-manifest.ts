export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"
import { SessionPolicy } from "./session-policy"
import { SessionTaskEvent } from "./session-task-event"
import { Schema } from "effect"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

const SessionSyncDefinitions = Event.inventory(
  SessionPolicy.Reviewed,
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
  ...SessionTaskEvent.Definitions,
)

export const SessionSyncDurable = {
  definitions: Event.durable(SessionSyncDefinitions),
  schema: Schema.Union(SessionSyncDefinitions, { mode: "oneOf" }),
} as const

export const Durable = SessionSyncDurable.definitions

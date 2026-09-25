export * as SessionAgentActivity from "./session-agent-activity"

import { Schema } from "effect"

export const Item = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int,
  kind: Schema.Literals(["reply", "notice", "completed", "failed", "interrupted"]),
  alias: Schema.String,
  sessionID: Schema.String,
  waitCallID: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.Literals(["user", "agent", "system", "unknown"])),
})

export const Anchor = Schema.Struct({ id: Schema.String, seq: Schema.Int })

export const Page = Schema.Struct({
  activities: Schema.Array(Item),
  anchors: Schema.Array(Anchor),
  next: Schema.NullOr(Schema.Int),
})

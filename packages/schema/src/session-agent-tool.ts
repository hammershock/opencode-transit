export * as SessionAgentTool from "./session-agent-tool"

import { Schema } from "effect"

export const Alias = Schema.String.annotate({ description: "Stable, readable route such as /root/review" })

export const Spawn = Schema.Struct({
  alias: Alias,
  prompt: Schema.String,
  subagent_type: Schema.String,
  target: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
})

export const Connect = Schema.Struct({
  alias: Alias,
  session_id: Schema.String,
  user_message_id: Schema.optional(Schema.String),
})

export const Interact = Schema.Struct({
  target: Alias.annotate({ description: "An alias from the visible Agent routes" }),
  message: Schema.String,
  kind: Schema.optional(Schema.Literals(["request", "reply", "notice"])),
  reply_to: Schema.optional(Schema.String),
  queue: Schema.optional(Schema.Boolean),
  resume: Schema.optional(Schema.Boolean),
})

export const Inspect = Schema.Struct({ alias: Schema.optional(Alias) })
export const Wait = Schema.Struct({
  aliases: Schema.optional(Schema.Array(Alias)),
  timeout_ms: Schema.optional(Schema.Number),
})
export const Interrupt = Schema.Struct({ alias: Alias })

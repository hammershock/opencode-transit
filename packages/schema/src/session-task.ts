export * as SessionTask from "./session-task"

import { Schema } from "effect"
import { SessionID } from "./session-id"

export const Invocation = Schema.Struct({
  parent_session_id: SessionID,
  parent_message_id: Schema.String,
  call_id: Schema.String,
})

export const Target = Schema.Struct({
  task_id: SessionID,
  invocation: Schema.optional(Invocation),
})

export const View = Schema.Struct({
  target: Target,
  description: Schema.String,
  agent_id: Schema.String,
  location: Schema.Struct({
    target_id: Schema.optional(Schema.String),
    target_name: Schema.optional(Schema.String),
    directory: Schema.optional(Schema.String),
  }),
  lifecycle: Schema.Literals(["admitted", "active", "settled", "unscoped_legacy"]),
  outcome: Schema.optional(Schema.Literals(["completed", "failed", "cancelled"])),
  runtime: Schema.Literals(["observed", "unknown", "unavailable"]),
  phase: Schema.Literals(["queued", "model", "tool", "permission", "question", "unknown"]),
  eligibility: Schema.optional(Schema.Literals(["eligible", "frozen", "none"])),
  cancellation: Schema.Literals(["none", "requested", "observed"]),
  lifecycle_source: Schema.Literals(["durable", "legacy_projection"]),
  input_id: Schema.optional(Schema.String),
  disposition: Schema.optional(Schema.Literals(["none", "abandoned_unknown"])),
  owner_safety: Schema.optional(Schema.Literals(["confirmed_local_lease", "unknown", "not_required"])),
  root_quota: Schema.optional(
    Schema.Struct({
      active_used: Schema.Int,
      active_limit: Schema.Int,
      pending_used: Schema.Int,
      pending_limit: Schema.Int,
    }),
  ),
  runtime_observation: Schema.optional(
    Schema.Struct({
      source: Schema.Literal("execution_owner"),
      owner_generation: Schema.String,
      observed_at: Schema.Finite,
    }),
  ),
  read_at: Schema.Finite,
  last_progress_at: Schema.optional(Schema.Finite),
  active_tools: Schema.Array(
    Schema.Struct({ name: Schema.String, call_id: Schema.String, started_at: Schema.optional(Schema.Finite) }),
  ),
  active_tool_count: Schema.Int,
  active_invocation: Schema.optional(Invocation),
  queued_count: Schema.Int,
  abandoned_unknown: Schema.optional(Schema.Boolean),
  result: Schema.optional(
    Schema.Struct({
      message_id: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
      truncated: Schema.Boolean,
    }),
  ),
})

export type Target = typeof Target.Type
export type View = typeof View.Type

export const StatusRequest = Schema.Struct({
  target: Schema.optional(Target),
  targets: Schema.optional(Schema.Array(Target)),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
  include_results: Schema.optional(Schema.Boolean),
})

export const StatusPage = Schema.Struct({
  data: Schema.Array(View),
  next: Schema.optional(Schema.String),
})

export * as SessionTaskCapability from "./task-capability"

import { Context, Effect } from "effect"

export type Feature =
  | "atomic_admission"
  | "exact_owner_guard"
  | "durable_queue"
  | "reconcile"
  | "exact_cancellation"
  | "exact_result"
  | "notification"

export type Backend = {
  readonly id: "legacy_task_prompt_ops" | "session_v2"
  readonly features: ReadonlySet<Feature>
}

/** The host advertises its actual Task execution adapter at the public boundary. */
export class Service extends Context.Service<Service, Backend>()("@opencode/SessionTaskCapability") {}

const required: readonly Feature[] = [
  "atomic_admission",
  "exact_owner_guard",
  "durable_queue",
  "reconcile",
  "exact_cancellation",
  "exact_result",
  "notification",
]

/** A partial adapter cannot advertise any of the RFC-0023 control surface. */
export function evaluate(backend: Backend) {
  const missing = required.filter((feature) => !backend.features.has(feature))
  return missing.length === 0
    ? { status: "supported" as const, backend: backend.id }
    : { status: "unsupported" as const, backend: backend.id, missing }
}

export const legacyTaskPromptOps = {
  id: "legacy_task_prompt_ops",
  features: new Set<Feature>(["atomic_admission", "exact_result"]),
} satisfies Backend

/** The V2 inbox, owner, and Task result services implement the complete control contract. */
export const sessionV2 = {
  id: "session_v2",
  features: new Set<Feature>(required),
} satisfies Backend

export class Unsupported extends Error {
  readonly code = "task_control_unsupported"
  constructor(readonly missing: readonly Feature[]) {
    super(`task_control_unsupported: backend lacks ${missing.join(", ")}`)
  }
}

export function requireControl(backend: Backend) {
  const capability = evaluate(backend)
  return capability.status === "supported"
    ? Effect.succeed(capability)
    : Effect.fail(new Unsupported(capability.missing))
}

import type { SubagentEconomicsCatalog, SubagentEconomicsRefresh } from "@opencode-ai/protocol/groups/session"
import type { SessionV2 } from "@opencode-ai/core/session"
import { Context, Effect } from "effect"

export type View = {
  readonly subagentCatalog: typeof SubagentEconomicsCatalog.Type | null
  readonly subagentGuidance: string | null
  readonly subagentRefresh: typeof SubagentEconomicsRefresh.Type
}

export interface Interface {
  readonly activate: (input: { sessionID: SessionV2.ID; directory: string; agent?: string }) => Effect.Effect<View>
  readonly inspect: (input: { sessionID: SessionV2.ID; directory: string }) => Effect.Effect<View>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContextExtension") {}

export * as SessionContextExtension from "./session-context-extension"

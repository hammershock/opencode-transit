import { Context, Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Agent } from "./agent"

/** Map a location-scoped Core AgentV2 definition to the narrow legacy Agent.Info shape. */
export function mapAgentV2(info: AgentV2.Info): Agent.Info {
  return {
    id: info.id,
    name: info.id,
    mode: info.mode,
    permission: info.permissions.map((rule) => ({
      permission: rule.action,
      pattern: rule.resource,
      action: rule.effect,
    })),
    model: info.model ? { modelID: info.model.id, providerID: info.model.providerID } : undefined,
    variant: info.model?.variant,
    prompt: info.system,
    description: info.description,
    hidden: info.hidden,
    color: info.color,
    steps: info.steps,
    options: {},
    native: false,
    source: "compatibility",
    editable: false,
  }
}

/**
 * Resolve the live Agent definition at a Location from its Core AgentV2 registry.
 * Waits for the location's internal plugins so the registry is fully materialized.
 */
export function resolveLocationAgent(
  agentID: string,
  context: Context.Context<AgentV2.Service | PluginV2.Service>,
): Effect.Effect<Agent.Info | undefined> {
  return Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
    const agents = yield* AgentV2.Service
    const info = yield* agents.resolve(AgentV2.ID.make(agentID))
    return info ? mapAgentV2(info) : undefined
  }).pipe(Effect.provide(context))
}

export * as SystemAssembly from "./system-assembly"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ModelContext } from "@opencode-ai/schema/model-context"
import { AgentV2 } from "@opencode-ai/core/agent"
import { RuntimeContext } from "@opencode-ai/core/runtime-context"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { SessionID } from "./schema"
import { SystemPrompt } from "./system"

export type SystemPart = ModelContext.SystemPart

export interface Assembled {
  readonly systemParts: ReadonlyArray<SystemPart>
  readonly system: ReadonlyArray<string>
}

export interface AssembleInput {
  readonly sessionID: SessionID
  readonly agent: Agent.Info
  readonly model: Provider.Model
  readonly permission?: PermissionV1.Ruleset
  readonly economicsGuidance: Effect.Effect<string | undefined>
}

export interface Interface {
  readonly assemble: (input: AssembleInput) => Effect.Effect<Assembled>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemAssembly") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sys = yield* SystemPrompt.Service
    const locationAccess = yield* SessionLocationAccess.Service
    const locations = yield* LocationServiceMap.Service

    const assembleRuntimeContext = (sessionID: SessionID, agent: Agent.Info) =>
      Effect.gen(function* () {
        const location = yield* locationAccess.require(sessionID).pipe(Effect.catch(Effect.die))
        return yield* Effect.gen(function* () {
          const agentV2 = yield* AgentV2.Service
          const selection = yield* agentV2.select(agent.name)
          const runtime = yield* RuntimeContext.Service
          return yield* runtime.assemble(sessionID, selection)
        }).pipe(Effect.provide(locations.get(location)))
      })

    const assemble = Effect.fn("SystemAssembly.assemble")(function* (input: AssembleInput) {
      const [parts, economicsGuidance, mcpInstructions] = yield* Effect.all([
        assembleRuntimeContext(input.sessionID, input.agent),
        input.economicsGuidance,
        sys.mcp(input.agent, input.permission),
      ])
      const agentPrompt = input.agent.prompt ?? SystemPrompt.provider(input.model).join("\n")
      const modelIdentity = `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`
      const systemParts: SystemPart[] = [
        { key: "agent", label: "Agent system prompt", tag: "<agent-system-prompt>", text: agentPrompt },
        { key: "model", label: "Model identity", tag: "<model>", text: modelIdentity },
        ...parts,
        ...(economicsGuidance
          ? [
              {
                key: "subagent-economics",
                label: "Subagent economics",
                tag: "<available_subagents>",
                text: economicsGuidance,
              },
            ]
          : []),
        ...(mcpInstructions
          ? [{ key: "mcp", label: "MCP instructions", tag: "<mcp_instructions>", text: mcpInstructions }]
          : []),
      ]
      // The provider prompt is prepended by `LLMRequestPrep.prepare`, so the
      // emitted system excludes the agent segment to avoid duplicating it.
      const system = systemParts.slice(1).map((part) => part.text).filter((part) => part.length > 0)
      return { systemParts, system }
    })

    return Service.of({ assemble })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    SystemPrompt.node,
    SessionLocationAccess.node,
    LocationServiceMap.node,
    AgentV2.node,
    RuntimeContext.node,
  ],
})

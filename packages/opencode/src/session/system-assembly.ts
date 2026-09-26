export * as SystemAssembly from "./system-assembly"

import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ModelContext } from "@opencode-ai/schema/model-context"
import { AgentV2 } from "@opencode-ai/core/agent"
import { RuntimeContext } from "@opencode-ai/core/runtime-context"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "@/agent/agent"
import { Subagent } from "@/agent/subagent"
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
      const [parts, mcpInstructions, subagentOption] = yield* Effect.all([
        assembleRuntimeContext(input.sessionID, input.agent),
        sys.mcp(input.agent, input.permission),
        Effect.serviceOption(Subagent.Service),
      ])
      const subagentText = yield* Option.match(subagentOption, {
        onNone: () => Effect.succeed(undefined),
        onSome: (subagents) =>
          subagents
            .resolve({
              parentAgentID: input.agent.id ?? input.agent.name,
              sessionID: input.sessionID,
              includeInactive: false,
            })
            .pipe(
              Effect.map((snapshot) =>
                snapshot.entries.some((entry) => entry.effective === "active") ? subagents.render(snapshot) : undefined,
              ),
            ),
      })
      const selected = SystemPrompt.providerSelection(input.model)
      const agentPrompt = input.agent.prompt ?? selected.prompt
      const modelIdentity = `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`
      const systemParts: SystemPart[] = [
        {
          key: "agent",
          label: "Agent system prompt",
          tag: "<agent-system-prompt>",
          text: agentPrompt,
          ...(input.agent.prompt === undefined ? { source: selected.source } : {}),
        },
        { key: "model", label: "Model identity", tag: "<model>", text: modelIdentity },
        ...parts,
        ...(subagentText
          ? [{ key: "subagents", label: "Available subagents", tag: "<available-subagents>", text: subagentText }]
          : []),
        ...(mcpInstructions
          ? [{ key: "mcp", label: "MCP instructions", tag: "<mcp_instructions>", text: mcpInstructions }]
          : []),
      ]
      // The provider prompt is prepended by `LLMRequestPrep.prepare`, so the
      // emitted system excludes the agent segment to avoid duplicating it.
      const system = systemParts
        .slice(1)
        .map((part) => part.text)
        .filter((part) => part.length > 0)
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
    Subagent.node,
  ],
})

import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () =>
      Effect.gen(function* () {
        return yield* response(
          Effect.gen(function* () {
            const plugin = yield* PluginV2.Service
            yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
            const agents = yield* AgentV2.Service
            return yield* agents.all()
          }),
        )
      }),
    )
    .handle("agent.catalog", () =>
      response(
        Effect.gen(function* () {
          const plugin = yield* PluginV2.Service
          yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
          return yield* ConfigAgentPlugin.catalog()
        }),
      ),
    ),
)

import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ControllerFileSystem } from "@opencode-ai/core/controller-filesystem"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  Effect.gen(function* () {
    const fs = yield* ControllerFileSystem.Service
    const global = yield* Global.Service
    const catalog = ConfigAgentPlugin.catalog().pipe(
      Effect.provideService(ControllerFileSystem.Service, fs),
      Effect.provideService(Global.Service, global),
    )
    return handlers
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
            return yield* catalog
          }),
        ),
      )
  }),
)

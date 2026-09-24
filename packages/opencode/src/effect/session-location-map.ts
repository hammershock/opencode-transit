import { buildLocationServiceMap, localProvider } from "@opencode-ai/core/location-services"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { rexdLocationProvider } from "@/rexd/location"
import { rexdTargetRegistryNode } from "@/rexd/target-registry"
import { OpenCodeSessionRunnerModel } from "@/session/runner-model"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { TaskV2Tool } from "@/tool/task-v2"

const builtInTools = makeLocationNode({
  name: "built-in-tools",
  layer: BuiltInTools.node.implementation!,
  deps: [TaskV2Tool.node, ...BuiltInTools.node.dependencies],
})

/** Both embedded Task execution and HTTP control must resolve the same Location services. */
export const sessionLocationMap = buildLocationServiceMap(
  [
    [TargetRegistry.node, rexdTargetRegistryNode],
    [SessionRunnerModel.node, OpenCodeSessionRunnerModel.node],
    [BuiltInTools.node, builtInTools],
  ],
  [localProvider, rexdLocationProvider],
)

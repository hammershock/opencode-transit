import { Effect, Layer, Scope } from "effect"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { sessionLocationMap } from "./session-location-map"
import { rexdTargetRegistryNode } from "@/rexd/target-registry"

const local = AppNodeBuilderV1.build(SessionExecutionLocal.node, [
  [LocationServiceMap.node, sessionLocationMap],
  [TargetRegistry.node, rexdTargetRegistryNode],
])

// TCP listeners have their own memo maps. Acquire execution through the process
// memo map so HTTP controls and embedded Task tools share the active owner.
// The acquiring runtime scope retains the service until that runtime closes.
export const sessionExecutionLayer = Layer.effectContext(
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    return yield* Layer.buildWithMemoMap(local, memoMap, scope)
  }),
)

import { Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"

/** Test and standalone graphs retain the legacy adapter unless production replaces this node. */
export const taskBackendNode = LayerNode.make({
  service: SessionTaskCapability.Service,
  layer: Layer.succeed(SessionTaskCapability.Service, SessionTaskCapability.legacyTaskPromptOps),
  deps: [],
})

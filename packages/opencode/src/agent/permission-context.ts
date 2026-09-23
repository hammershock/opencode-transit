export * as PermissionContext from "./permission-context"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { ExecutionPolicy } from "@opencode-ai/core/permission/policy"
import { PluginV2 } from "@opencode-ai/core/plugin"
import type { Permission } from "@opencode-ai/schema/permission"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

export function legacy(rules: Permission.Ruleset) {
  return rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }))
}

export class Service extends Context.Service<
  Service,
  {
    resolve: (sessionID: SessionSchema.ID, agentID?: string) => Effect.Effect<ExecutionPolicy.Snapshot>
  }
>()("@opencode/PermissionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const access = yield* SessionLocationAccess.Service
    return Service.of({
      resolve: Effect.fn("PermissionContext.resolve")(function* (sessionID, agentID) {
        const location = yield* access.require(sessionID).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          const plugin = yield* PluginV2.Service
          yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
          const policy = yield* ExecutionPolicy.Service
          return yield* policy.resolve(sessionID, agentID)
        }).pipe(Effect.provide(locations.get(location)), Effect.orDie)
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [LocationServiceMap.node, SessionLocationAccess.node],
})

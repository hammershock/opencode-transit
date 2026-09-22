import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Scope, Context } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { AgentPermission } from "@/agent/agent-permission"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { ShareNext } from "./share-next"

export interface Interface {
  readonly create: (input?: Session.CreateOptions) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const locations = yield* LocationServiceMap.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateOptions) {
      if (input?.parentID) return yield* session.create(input)
      const ctx = yield* InstanceState.context
      const conf = yield* cfg.get()
      const permission = yield* AgentPermission.resolveSessionPermission(locations, {
        permission: input?.permission,
        directory: ctx.directory,
        target: input?.target,
        withReferences: Object.keys(conf.references ?? conf.reference ?? {}).length > 0,
      })
      const result = yield* session.create({
        ...input,
        permission,
      })
      if (!(flags.autoShare || conf.share === "auto")) return result
      yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Session.node, ShareNext.node, RuntimeFlags.node, LocationServiceMap.node],
})

export * as SessionShare from "./session"

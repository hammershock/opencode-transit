export * as RuntimeContext from "."

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionIdleCache } from "../session/idle-cache"

/**
 * Per-turn reconstructed, never-persisted model-visible context.
 *
 * Runtime context parts are the counterpart to durable `SystemContext` sources:
 * they are computed fresh, injected as separate system parts, and never written
 * into the Context Epoch, Session events, sync, or compaction. Parts declared
 * `cache: "session"` are built once per Session and reused in-process; parts
 * declared `cache: "turn"` (the default) are rebuilt on every provider turn.
 * Both the runner and the `/context` inspector read the same `assemble` output.
 */
export interface Part {
  readonly key: string
  readonly label: string
  readonly tag: string
  readonly order: number
  readonly cache?: "turn" | "session"
  readonly enabled: (agent: AgentV2.Selection) => boolean
  readonly render: (sessionID: SessionSchema.ID, agent: AgentV2.Selection) => Effect.Effect<string | undefined>
}

export interface Rendered {
  readonly key: string
  readonly label: string
  readonly tag: string
  readonly text: string
}

export interface Interface {
  readonly register: (part: Part) => Effect.Effect<void, never, Scope.Scope>
  readonly assemble: (sessionID: SessionSchema.ID, agent: AgentV2.Selection) => Effect.Effect<ReadonlyArray<Rendered>>
  readonly invalidate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const parts = yield* Ref.make<ReadonlyArray<Part>>([])
    const idleCache = yield* SessionIdleCache.Service
    const cache = new Map<string, Rendered>()

    const register = Effect.fn("RuntimeContext.register")(function* (part: Part) {
      yield* Effect.acquireRelease(
        Ref.modify(parts, (current) =>
          current.some((item) => item.key === part.key) ? [false, current] : [true, [...current, part]],
        ).pipe(
          Effect.flatMap((added) =>
            added ? Effect.void : Effect.die(`Duplicate runtime context part key: ${part.key}`),
          ),
          Effect.as(part),
        ),
        (part) => Ref.update(parts, (current) => current.filter((item) => item !== part)),
      )
    })

    const resource: SessionIdleCache.Resource = {
      evict: (sessionID) => {
        const prefix = `${sessionID}\u0000`
        for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
      },
    }
    const invalidate = (sessionID: SessionSchema.ID) =>
      Effect.sync(() => {
        resource.evict(sessionID)
        idleCache.forget(sessionID, resource)
      })

    const assemble = Effect.fn("RuntimeContext.assemble")(function* (
      sessionID: SessionSchema.ID,
      agent: AgentV2.Selection,
    ) {
      const enabled = (yield* Ref.get(parts))
        .filter((part) => part.enabled(agent))
        .toSorted((a, b) => a.order - b.order)
      const rendered = yield* Effect.forEach(
        enabled,
        (part) =>
          Effect.gen(function* () {
            const cacheKey = `${sessionID}\u0000${part.key}`
            if (part.cache === "session") {
              const cached = cache.get(cacheKey)
              if (cached) return cached
            }
            const text = yield* part.render(sessionID, agent)
            const result =
              text && text.length > 0 ? { key: part.key, label: part.label, tag: part.tag, text } : undefined
            if (part.cache === "session" && result) {
              cache.set(cacheKey, result)
              idleCache.retain(sessionID, resource)
            }
            return result
          }),
        { concurrency: "unbounded" },
      )
      return rendered.filter((item): item is Rendered => item !== undefined)
    })

    return Service.of({ register, assemble, invalidate })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SessionIdleCache.node] })

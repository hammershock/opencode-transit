export * as RuntimeContext from "."

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"

/**
 * Per-turn reconstructed, never-persisted model-visible context.
 *
 * Runtime context parts are the counterpart to durable `SystemContext` sources:
 * they are computed fresh on every provider turn, injected as separate system
 * parts, and never written into the Context Epoch, Session events, sync, or
 * compaction. Both the runner and the `/context` inspector read the same
 * `assemble` output so the injected text and the inspection preview cannot drift.
 */
export interface Part {
  readonly key: string
  readonly label: string
  readonly tag: string
  readonly order: number
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
  readonly assemble: (
    sessionID: SessionSchema.ID,
    agent: AgentV2.Selection,
  ) => Effect.Effect<ReadonlyArray<Rendered>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const parts = yield* Ref.make<ReadonlyArray<Part>>([])

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
          Effect.map(part.render(sessionID, agent), (text) =>
            text && text.length > 0 ? ({ key: part.key, label: part.label, tag: part.tag, text }) : undefined,
          ),
        { concurrency: "unbounded" },
      )
      return rendered.filter((item): item is Rendered => item !== undefined)
    })

    return Service.of({ register, assemble })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })

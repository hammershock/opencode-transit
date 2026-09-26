import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testEffect } from "./lib/effect"

const Signal = EventV2.define({ type: "test.bridge.signal", schema: { label: Schema.String } })

const it = testEffect(LayerNode.compile(EventV2.node, [[Database.node, Database.layerFromPath(":memory:")]]))

it.live("forwards once when two bridge layers share one event service", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const bridge = LayerNode.compile(EventV2Bridge.node, [
      [EventV2.node, Layer.succeed(EventV2.Service, events)],
      [SessionSync.node, Layer.succeed(SessionSync.Capture, true)],
    ])
    const first = yield* Scope.make()
    const second = yield* Scope.make()
    const seen: string[] = []
    const listener = (event: { payload: { type: string; properties?: { label?: string } } }) => {
      if (event.payload.type === Signal.type) seen.push(event.payload.properties?.label ?? "")
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

    yield* Layer.buildWithScope(Layer.fresh(bridge), first)
    yield* Layer.buildWithScope(Layer.fresh(bridge), second)
    yield* events.publish(Signal, { label: "first" })
    expect(seen).toEqual(["first"])

    yield* Scope.close(first, Exit.void)
    yield* events.publish(Signal, { label: "second" })
    expect(seen).toEqual(["first", "second"])

    yield* Scope.close(second, Exit.void)
    yield* events.publish(Signal, { label: "third" })
    expect(seen).toEqual(["first", "second"])
  }),
)

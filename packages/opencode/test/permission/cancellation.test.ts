import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(Permission.node, [
    [EventV2Bridge.node, Layer.mock(EventV2Bridge.Service, { publish: () => Effect.never })],
  ]),
)

it.instance("cancellation during permission publication releases its pending request", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bridge = yield* EffectBridge.make()
    const abort = new AbortController()
    const pending = bridge
      .promise(
        permission.ask({
          sessionID: SessionID.make("ses_cancel_permission"),
          permission: "read",
          patterns: ["*"],
          always: [],
          metadata: {},
          ruleset: [],
        }),
        { signal: abort.signal },
      )
      .catch(() => "cancelled")
    yield* pollWithTimeout(
      permission.list().pipe(Effect.map((requests) => (requests.length === 1 ? true : undefined))),
      "permission never registered",
    )
    abort.abort()
    expect(yield* Effect.promise(() => pending).pipe(Effect.timeout("2 seconds"))).toBe("cancelled")
    expect(yield* permission.list()).toEqual([])
  }),
)

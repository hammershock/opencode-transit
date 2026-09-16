import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { Context, Deferred, Effect, Layer } from "effect"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectBridge } from "@/effect/bridge"
import { rexdFilesystemNodes } from "@/rexd/location-filesystem"
import { RexdLocationSession, rexdSessionNode } from "@/rexd/location-session"
import type { RexdLease } from "@/rexd/connection"

for (const operation of ["glob", "grep"] as const) {
  test(`Effect cancellation releases pending remote ${operation} requests without fallback`, async () => {
    const started = Deferred.makeUnsafe<AbortSignal>()
    const aborted = Deferred.makeUnsafe<void>()
    const calls: string[] = []
    const lease = {
      handshake: { sessionID: "isolated", workspaceRoots: ["/remote-only"] },
      client: {
        request(method: string, _params: unknown, options: { signal?: AbortSignal }) {
          calls.push(method)
          const signal = options.signal!
          Effect.runSync(Deferred.succeed(started, signal))
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                Effect.runSync(Deferred.succeed(aborted, undefined))
                reject(new Error("cancelled"))
              },
              { once: true },
            ),
          )
        },
      },
    } as unknown as RexdLease
    const directory = AbsolutePath.make("/remote-only")
    const session = rexdSessionNode(
      Location.Ref.make({
        directory,
        target: { type: "rexd", targetID: Location.TargetID.make("11111111-1111-4111-8111-111111111111") },
      }),
    )
    const layer = LayerNode.compile(rexdFilesystemNodes(session, "isolated", directory)[1], [
      [session, Layer.succeed(RexdLocationSession, lease)],
    ])
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const filesystem = Context.get(context, FileSystem.Service)
          const bridge = yield* EffectBridge.make()
          const abort = new AbortController()
          const result = bridge
            .promise(
              operation === "glob"
                ? filesystem.glob({ pattern: "*" }).pipe(Effect.asVoid)
                : filesystem.grep({ pattern: "test" }).pipe(Effect.asVoid),
              {
                signal: abort.signal,
              },
            )
            .catch(() => "cancelled")
          const signal = yield* Deferred.await(started)
          abort.abort()
          expect(yield* Effect.promise(() => result)).toBe("cancelled")
          yield* Deferred.await(aborted).pipe(Effect.timeout("2 seconds"))
          expect(signal.aborted).toBe(true)
          expect(getEventListeners(abort.signal, "abort")).toHaveLength(0)
          expect(calls).toEqual([operation === "glob" ? "fs.glob" : "fs.stat"])
        }),
      ),
    )
  })
}

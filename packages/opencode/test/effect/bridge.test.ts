import { expect } from "bun:test"
import { getEventListeners } from "node:events"
import { Deferred, Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectBridge } from "@/effect/bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

it.live("abort releases the real owned subprocess after stdout readiness", () =>
  Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    const processService = yield* AppProcess.Service
    const ready = yield* Deferred.make<number>()
    const abort = new AbortController()
    const pending = bridge
      .promise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* processService.spawn(
              ChildProcess.make(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 60000)"]),
            )
            yield* Stream.decodeText(handle.stdout).pipe(
              Stream.splitLines,
              Stream.take(1),
              Stream.runForEach((line) => Deferred.succeed(ready, Number(line))),
            )
            return yield* handle.exitCode
          }),
        ),
        { signal: abort.signal },
      )
      .then(
        () => false,
        () => true,
      )
    const pid = yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    abort.abort()
    expect(yield* Effect.promise(() => pending).pipe(Effect.timeout("5 seconds"))).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0)
  }),
)

it.live("repeated abort and completion remove listeners and preserve typed failure", () =>
  Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    yield* Effect.forEach(Array.from({ length: 30 }), () =>
      Effect.gen(function* () {
        const abort = new AbortController()
        const started = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        const pending = bridge
          .promise(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
            { signal: abort.signal },
          )
          .catch(() => "cancelled")
        yield* Deferred.await(started)
        abort.abort()
        abort.abort()
        expect(yield* Effect.promise(() => pending)).toBe("cancelled")
        yield* Deferred.await(released)
        expect(getEventListeners(abort.signal, "abort")).toHaveLength(0)
        const complete = new AbortController()
        const error = new Error("expected typed failure")
        const failed = bridge.promise(Effect.fail(error), { signal: complete.signal }).catch((cause) => cause)
        complete.abort()
        expect(yield* Effect.promise(() => failed)).toBe(error)
        expect(getEventListeners(complete.signal, "abort")).toHaveLength(0)
      }),
    )
  }),
)

import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionIdleCache } from "@opencode-ai/core/session/idle-cache"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const id = (value: number) => SessionSchema.ID.make(`ses_cache_${value}`)

describe("SessionIdleCache", () => {
  test("keeps 128 idle entries and evicts the oldest without Inspect refreshing recency", () => {
    const cache = SessionIdleCache.make()
    const evicted: SessionSchema.ID[] = []
    const resource = { evict: (sessionID: SessionSchema.ID) => evicted.push(sessionID) }
    for (let index = 0; index < 128; index++) cache.retain(id(index), resource)
    cache.retain(id(0), resource) // A read-only inspection does not touch the LRU.
    expect(cache.snapshot().idle).toHaveLength(128)
    expect(evicted).toEqual([])

    cache.retain(id(128), resource)
    expect(evicted).toEqual([id(0)])
    expect(cache.snapshot().idle).toHaveLength(128)
    cache.active(id(1))
    cache.retain(id(129), resource)
    expect(evicted).toEqual([id(0)])
    expect(cache.snapshot().active).toEqual([id(1)])
    cache.idle(id(1))
    expect(evicted).toEqual([id(0), id(2)])
    expect(cache.snapshot().idle.at(-1)).toBe(id(1))
    expect(cache.snapshot().idle).toHaveLength(128)
    cache.forget(id(1), resource)
    expect(cache.snapshot().idle).not.toContain(id(1))
  })

  it.effect("pins at admission, preserves active work, and reuses a Session after eviction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = SessionIdleCache.make(1)
        const evicted: SessionSchema.ID[] = []
        const resource = { evict: (sessionID: SessionSchema.ID) => evicted.push(sessionID) }
        cache.retain(id(0), resource)
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          onActive: cache.active,
          onIdle: cache.idle,
          drain: (sessionID: SessionSchema.ID) =>
            sessionID === id(0)
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void,
        })
        yield* coordinator.wake(id(0))
        expect(cache.snapshot().active).toEqual([id(0)])
        yield* Deferred.await(entered)
        cache.retain(id(1), resource)
        expect(evicted).toEqual([])
        const joined = yield* coordinator.run(id(0)).pipe(Effect.forkChild)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(joined)
        yield* Effect.yieldNow
        expect(cache.snapshot().active).toEqual([])
        expect(evicted).toEqual([id(1)])

        cache.retain(id(2), resource)
        expect(evicted).toEqual([id(1), id(0)])
        cache.active(id(0))
        cache.retain(id(0), resource)
        expect(cache.snapshot().active).toEqual([id(0)])
        cache.idle(id(0))
        expect(cache.snapshot().idle).toEqual([id(0)])
      }),
    ),
  )

  it.effect("returns interrupted work to the idle LRU without retaining an execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = SessionIdleCache.make(1)
        const entered = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          onActive: cache.active,
          onIdle: cache.idle,
          drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const resource = { evict: () => undefined }
        cache.retain(id(0), resource)
        yield* coordinator.wake(id(0))
        yield* Deferred.await(entered)
        expect(cache.snapshot().active).toEqual([id(0)])
        yield* coordinator.interrupt(id(0))
        expect(cache.snapshot().active).toEqual([])
        expect(cache.snapshot().idle).toEqual([id(0)])
      }),
    ),
  )
})

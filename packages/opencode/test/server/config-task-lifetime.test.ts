import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceStore } from "../../src/project/instance-store"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test.each(["/global/config", "/config"])("saving %s preserves live tasks and config snapshots", async (endpoint) => {
  await using first = await tmpdir({ config: { formatter: false, lsp: false } })
  await using second = await tmpdir({ config: { formatter: false, lsp: false } })
  await AppRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const config = yield* Config.Service
        const contexts = yield* Effect.forEach([first.path, second.path], (directory) => store.load({ directory }))
        const release = yield* Deferred.make<void>()
        const completed: string[] = []
        const state = yield* InstanceState.make((ctx) =>
          Deferred.await(release).pipe(
            Effect.tap(() => Effect.sync(() => completed.push(ctx.directory))),
            Effect.forkScoped({ startImmediately: true }),
          ),
        )
        const fibers = yield* Effect.forEach(contexts, (ctx) =>
          InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx)),
        )
        const snapshots = yield* Effect.forEach(contexts, (ctx) =>
          config.get().pipe(Effect.provideService(InstanceRef, ctx)),
        )
        try {
          for (const enabled of [true, false, true]) {
            const response = yield* Effect.promise(() =>
              Promise.resolve(
                Server.Default().app.request(endpoint, {
                  method: "PATCH",
                  headers: { "content-type": "application/json", "x-opencode-directory": first.path },
                  body: JSON.stringify({ experimental: { subagent_economics: enabled } }),
                }),
              ),
            )
            expect(response.status).toBe(200)
            // The old global handler forks disposal after returning the response.
            yield* Effect.sleep("100 millis")
            for (const fiber of fibers) expect(fiber.pollUnsafe()).toBeUndefined()
            for (const [index, ctx] of contexts.entries()) {
              expect(yield* store.load({ directory: ctx.directory })).toBe(ctx)
              expect(yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))).toBe(snapshots[index])
            }
          }
          if (endpoint === "/global/config") {
            expect((yield* config.getGlobal()).experimental?.subagent_economics).toBe(true)
          }
          yield* Deferred.succeed(release, undefined)
          yield* Effect.forEach(fibers, Fiber.join)
          expect(completed.sort()).toEqual([first.path, second.path].sort())

          // Explicit disposal still closes instance-owned scopes; saving does not.
          const cancellable = yield* InstanceState.make(() => Effect.never.pipe(Effect.forkScoped()))
          const fiber = yield* InstanceState.get(cancellable).pipe(Effect.provideService(InstanceRef, contexts[0]))
          yield* store.dispose(contexts[0])
          const cancelled = yield* Fiber.await(fiber)
          expect(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause)).toBe(true)
          const fresh = yield* store.load({ directory: first.path })
          expect(
            (yield* config.get().pipe(Effect.provideService(InstanceRef, fresh))).experimental?.subagent_economics,
          ).toBe(true)
        } finally {
          yield* store.disposeAll()
        }
      }),
    ),
  )
})

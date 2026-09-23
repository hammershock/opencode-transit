import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Location } from "@opencode-ai/core/location"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const targets = [
  Location.RexdTarget.make({ type: "rexd", targetID: Location.TargetID.make("a20c4f65-7ad8-47ae-bc91-7f2b9476108d") }),
  Location.RexdTarget.make({ type: "rexd", targetID: Location.TargetID.make("b20c4f65-7ad8-47ae-bc91-7f2b9476108d") }),
]

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer((ctx) => disposer(ctx.directory))),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("isolates equal directories on local and two remote targets", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const local = yield* store.load({ directory: dir })
      const [a, b, again] = yield* Effect.all(
        [targets[0], targets[1], targets[0]].map((target) => store.load({ directory: dir, target })),
        { concurrency: "unbounded" },
      )
      expect(a).not.toBe(local)
      expect(b).not.toBe(local)
      expect(a).not.toBe(b)
      expect(again).toBe(a)
      expect(a.target).toEqual(targets[0])
      expect(b.target).toEqual(targets[1])
      expect(yield* store.load({ directory: dir, target: { type: "local" } })).toBe(local)
    }),
  )

  it.live("isolates explicit workspace identities at one target and directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const a = { directory: dir, target: targets[0], workspaceID: WorkspaceV2.ID.make("wrk_one") }
      const b = { ...a, workspaceID: WorkspaceV2.ID.make("wrk_two") }
      const first = yield* store.load(a)
      expect(yield* store.load(a)).toBe(first)
      expect(yield* store.load(b)).not.toBe(first)
      expect(yield* store.load({ directory: dir, target: targets[0] })).not.toBe(first)
    }),
  )

  it.live("provides the selected workspace during bootstrap and scoped work", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_selected")
      const seen: Array<WorkspaceV2.ID | undefined> = []
      yield* setBootstrap(
        Effect.gen(function* () {
          seen.push(yield* WorkspaceRef)
        }),
      )
      const input = { directory: dir, target: targets[0], workspaceID }
      expect(yield* store.provide(input, WorkspaceRef)).toBe(workspaceID)
      expect(seen).toEqual([workspaceID])
      const inherited = yield* store
        .load({ directory: dir, target: targets[0] })
        .pipe(Effect.provideService(WorkspaceRef, workspaceID))
      expect(inherited).toBe(yield* store.load(input))
      const cleared = yield* store
        .provide({ ...input, workspaceID: undefined }, WorkspaceRef)
        .pipe(Effect.provideService(WorkspaceRef, workspaceID))
      expect(cleared).toBeUndefined()
      expect(seen).toEqual([workspaceID, undefined])
    }),
  )

  it.live("directory disposal retires local workspace views without touching a remote boot", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const local = yield* store.load({ directory })
      const input = { directory, workspaceID: WorkspaceV2.ID.make("wrk_local") }
      const workspace = yield* store.load(input)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const remote = yield* store.load({ directory, target: targets[0] }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* store
        .disposeDirectory(directory)
        .pipe(Effect.timeout("2 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)))
      const other = yield* Fiber.join(remote)
      yield* setBootstrap(Effect.void)
      expect(yield* store.load({ directory })).not.toBe(local)
      expect(yield* store.load(input)).not.toBe(workspace)
      expect(yield* store.load({ directory, target: targets[0] })).toBe(other)
    }),
  )

  it.live("reload joins concurrent disposal of the same generation", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const input = { directory: dir, target: targets[0] }
      const first = yield* store.load(input)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const disposed: object[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((ctx) =>
            Effect.runPromise(
              Effect.gen(function* () {
                disposed.push(ctx)
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }),
            ),
          ),
        ),
        (off) => Effect.sync(off),
      )
      const disposing = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const reloading = yield* store.reload(input).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      const next = yield* Fiber.join(reloading)
      yield* Fiber.join(disposing)
      expect(disposed).toEqual([first])
      expect(yield* store.load(input)).toBe(next)
      expect(next).not.toBe(first)
    }),
  )

  it.live("reload and directory disposal leave other targets and their state alive", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const closed: object[] = []
      const state = yield* InstanceState.make((ctx) =>
        Effect.acquireRelease(Effect.succeed({ ctx }), (value) =>
          Effect.sync(() => {
            closed.push(value)
          }),
        ),
      )
      const local = yield* store.load({ directory: dir })
      const a = yield* store.load({ directory: dir, target: targets[0] })
      const b = yield* store.load({ directory: dir, target: targets[1] })
      const l = yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, local))
      const first = yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, a))
      const other = yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, b))
      expect(first).not.toBe(other)
      const next = yield* store.reload({ directory: dir, target: targets[0] })
      const current = yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, next))
      expect(closed).toEqual([first])
      expect(current).not.toBe(first)
      yield* store.dispose(a)
      expect(closed).toEqual([first])
      expect(yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, b))).toBe(other)
      yield* store.disposeDirectory(dir)
      expect(closed).toEqual([first, l])
      expect(yield* store.load({ directory: dir, target: targets[0] })).toBe(next)
      expect(yield* store.load({ directory: dir, target: targets[1] })).toBe(b)
      yield* store.disposeAll()
      expect(closed).toHaveLength(4)
      expect(closed).toContain(current)
      expect(closed).toContain(other)
    }),
  )

  it.live("failed target boot retries without removing a same-path sibling", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const sibling = yield* store.load({ directory: dir, target: targets[1] })
      const closed: object[] = []
      const state = yield* InstanceState.make((ctx) =>
        Effect.acquireRelease(Effect.succeed({ ctx }), (value) =>
          Effect.sync(() => {
            closed.push(value)
          }),
        ),
      )
      yield* setBootstrap(InstanceState.get(state).pipe(Effect.andThen(Effect.die("target boot failed"))))
      const failed = yield* store.load({ directory: dir, target: targets[0] }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(closed).toHaveLength(1)
      expect(yield* store.load({ directory: dir, target: targets[1] })).toBe(sibling)
      yield* setBootstrap(Effect.void)
      const retried = yield* store.load({ directory: dir, target: targets[0] })
      expect(retried.target).toEqual(targets[0])
      expect(retried).not.toBe(sibling)
    }),
  )

  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("preserves the target on the loaded instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const target = Location.RexdTarget.make({
        type: "rexd",
        targetID: Location.TargetID.make("a20c4f65-7ad8-47ae-bc91-7f2b9476108d"),
      })
      const ctx = yield* store.load({ directory: dir, target })

      expect(ctx.target).toEqual(target)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )
})

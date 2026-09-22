import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceRegistry } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { instanceKey, type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import type { Location } from "@opencode-ai/core/location"
import { Project } from "./project"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
  target?: Location.Target
  workspaceID?: WorkspaceV2.ID
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly input: LoadInput
  readonly deferred: Deferred.Deferred<InstanceContext>
  readonly dispose: Effect.Effect<void>
}

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
                ...(input.target === undefined ? {} : { target: input.target }),
                ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                  ...(input.target === undefined ? {} : { target: input.target }),
                  ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
                })),
              )
        yield* bootstrap.run.pipe(
          Effect.provideService(InstanceRef, ctx),
          Effect.provideService(WorkspaceRef, ctx.workspaceID),
          Effect.onError(() => Effect.promise(() => InstanceRegistry.disposeInstance(ctx))),
        )
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (key: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(key) !== entry) return false
        cache.delete(key)
        return true
      })

    const completeLoad = (key: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot(input))
        if (Exit.isFailure(exit)) yield* removeEntry(key, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: InstanceContext) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project.id,
          workspace: input.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => InstanceRegistry.disposeInstance(ctx))
      yield* emitDisposed(ctx)
    })

    const makeEntry = (input: LoadInput) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<InstanceContext>()
        // Reload must join any in-flight teardown before booting the replacement.
        const dispose = yield* Effect.cached(
          Deferred.await(deferred).pipe(
            Effect.exit,
            Effect.flatMap((exit) => (Exit.isSuccess(exit) ? disposeContext(exit.value) : Effect.void)),
          ),
        )
        return { input, deferred, dispose }
      })

    const disposeEntry = Effect.fnUntraced(function* (key: string, entry: Entry) {
      if (cache.get(key) !== entry) return false
      yield* entry.dispose
      if (cache.get(key) !== entry) return false
      cache.delete(key)
      return true
    })

    const resolve = (input: LoadInput) =>
      Effect.gen(function* () {
        return {
          ...input,
          // A foreign path must not be interpreted relative to the controller cwd.
          directory: input.target?.type === "rexd" ? input.directory : FSUtil.resolve(input.directory),
          // Explicit Location adapters can clear an ambient workspace by passing undefined.
          workspaceID: Object.hasOwn(input, "workspaceID")
            ? input.workspaceID
            : ((yield* WorkspaceRef) ?? WorkspaceContext.workspaceID),
        }
      })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const resolved = yield* resolve(input)
          const key = instanceKey(resolved)
          const entry = yield* makeEntry(resolved)
          // Keep lookup and insertion adjacent: allocating the cached teardown
          // is effectful and can yield to another load at a scheduler boundary.
          const existing = cache.get(key)
          if (existing) return yield* restore(Deferred.await(existing.deferred))
          cache.set(key, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: resolved.directory, target: resolved.target })
            yield* completeLoad(key, resolved, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const resolved = yield* resolve(input)
          const key = instanceKey(resolved)
          const entry = yield* makeEntry(resolved)
          const previous = cache.get(key)
          cache.set(key, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: resolved.directory, target: resolved.target })
            if (previous) yield* previous.dispose
            yield* completeLoad(key, resolved, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const key = instanceKey(ctx)
      const entry = cache.get(key)
      if (!entry) return

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(key, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(key, entry).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      // Worktree removal owns this local path across workspace views, never a
      // same-named directory on another target. Do not await unrelated boots.
      yield* Effect.forEach(
        [...cache.entries()].filter(
          ([, entry]) => entry.input.directory === directory && entry.input.target?.type !== "rexd",
        ),
        ([key, entry]) => disposeEntry(key, entry),
        { discard: true },
      )
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1])
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(
        Effect.flatMap((ctx) =>
          effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, ctx.workspaceID)),
        ),
      )

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"

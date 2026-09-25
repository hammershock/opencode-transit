export * as SessionRunCoordinator from "./run-coordinator"

import { randomUUID } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Registers work and waits for the execution generation guaranteed to observe that wake. */
  readonly wakeAndWait: (key: Key) => Effect.Effect<void, E>
  /** Reserves an idle key for a scoped operation; wakes admitted during it run after release. */
  readonly exclusive: <A, E2, R>(
    key: Key,
    operation: Effect.Effect<A, E2, R>,
  ) => Effect.Effect<{ busy: true } | { busy: false; value: A }, E2, R>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /** Captures the current drain, including ordinary Sessions with no Task invocation. */
  readonly generation: (key: Key) => Effect.Effect<string | undefined>
  /** Stops only that drain; a late request cannot interrupt its successor. */
  readonly interruptGeneration: (key: Key, generation: string) => Effect.Effect<"interrupted" | "completed" | "stale">
  /** Bind an exact execution while its owner lease is held. */
  readonly bindExact: (key: Key, inputID: string, ownerGeneration: string) => () => void
  /** Compare and signal the bound fiber without waiting for cleanup under a child gate. */
  readonly requestInterruptExact: (key: Key, inputID: string, ownerGeneration: string) => boolean
}

type Entry<E> = {
  readonly generation: string
  readonly done: Deferred.Deferred<void, E>
  wakeDone?: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  pendingWake: boolean
  stopping: boolean
  exact?: { readonly inputID: string; readonly ownerGeneration: string }
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  /** Test/diagnostic observation only; callback failures never affect execution. */
  readonly onAdmission?: (event: { readonly key: Key; readonly type: "started" | "joined" }) => void
  /** Synchronous owner-boundary signals; they must not block or throw. */
  readonly onActive?: (key: Key) => void
  readonly onIdle?: (key: Key) => void
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      generation: randomUUID(),
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })
    const observe = (key: Key, type: "started" | "joined") => {
      try {
        options.onAdmission?.({ key, type })
      } catch {
        // Admission observation must not alter coordinator semantics.
      }
    }

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) {
        active.delete(key)
        options.onIdle?.(key)
      } else {
        successor.wakeDone = entry.wakeDone
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
      if (successor === undefined && entry.wakeDone !== undefined) Deferred.doneUnsafe(entry.wakeDone, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          observe(key, "joined")
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        options.onActive?.(key)
        observe(key, "started")
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const scheduleWake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          entry.wakeDone ??= Deferred.makeUnsafe<void, E>()
          return entry.wakeDone
        }

        const next = makeEntry()
        next.wakeDone = Deferred.makeUnsafe<void, E>()
        active.set(key, next)
        options.onActive?.(key)
        start(key, next, false)
        return next.wakeDone
      })

    const wake = (key: Key) => scheduleWake(key).pipe(Effect.asVoid)
    const wakeAndWait = (key: Key) => scheduleWake(key).pipe(Effect.flatMap(Deferred.await))

    const exclusive = <A, E2, R>(
      key: Key,
      operation: Effect.Effect<A, E2, R>,
    ): Effect.Effect<{ busy: true } | { busy: false; value: A }, E2, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* Effect.sync(() => {
            if (active.has(key)) return undefined
            const entry = makeEntry()
            active.set(key, entry)
            options.onActive?.(key)
            return entry
          })
          if (entry === undefined) return { busy: true as const }
          const value = yield* restore(operation).pipe(
            Effect.ensuring(Effect.sync(() => settle(key, entry, Exit.succeed(undefined)))),
          )
          return { busy: false as const, value }
        }),
      )

    const generation = (key: Key) => Effect.sync(() => active.get(key)?.generation)

    const interruptGeneration = (key: Key, expected: string): Effect.Effect<"interrupted" | "completed" | "stale"> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined || entry.generation !== expected) return Effect.succeed("stale" as const)
        entry.stopping = true
        entry.pendingWake = false
        entry.owner.interruptUnsafe()
        return Deferred.await(entry.done).pipe(
          Effect.exit,
          Effect.map((exit) =>
            Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? ("interrupted" as const) : ("completed" as const),
          ),
        )
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      generation(key).pipe(
        Effect.flatMap((current) => (current ? interruptGeneration(key, current).pipe(Effect.asVoid) : Effect.void)),
      )

    const bindExact = (key: Key, inputID: string, ownerGeneration: string) => {
      const entry = active.get(key)
      if (!entry?.owner) throw new Error("Cannot bind an execution without a coordinator owner")
      const binding = { inputID, ownerGeneration }
      entry.exact = binding
      return () => {
        if (entry.exact === binding) entry.exact = undefined
      }
    }

    const requestInterruptExact = (key: Key, inputID: string, ownerGeneration: string) => {
      const entry = active.get(key)
      if (!entry?.owner || entry.exact?.inputID !== inputID || entry.exact.ownerGeneration !== ownerGeneration)
        return false
      // Capture this fiber before releasing the child gate. Awaiting its cleanup
      // here would deadlock because settlement takes the same gate.
      entry.owner.interruptUnsafe()
      return true
    }

    return {
      active: Effect.sync(() => new Set(active.keys())),
      run,
      wake,
      wakeAndWait,
      exclusive,
      interrupt,
      generation,
      interruptGeneration,
      bindExact,
      requestInterruptExact,
    }
  })

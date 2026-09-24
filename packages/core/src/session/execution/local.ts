import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionLocationAccess } from "../location-access"
import { Database } from "../../database/database"
import { SessionTaskOwner } from "../task-owner"
import { SessionTaskTable } from "../sql"
import { SessionTask } from "../task"
import { SessionTaskScheduler } from "../task-scheduler"
import { SessionTaskResult } from "../task-result"
import { EventV2 } from "../../event"
import { asc, eq } from "drizzle-orm"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const access = yield* SessionLocationAccess.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    // The coordinator cannot schedule its successor until construction completes.
    let wake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    const exact: { bind?: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError>["bindExact"] } =
      {}
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const location = yield* access.require(sessionID).pipe(Effect.catch(Effect.die))
        const tasks = yield* database.db
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.child_session_id, sessionID))
          .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
          .all()
          .pipe(Effect.orDie)
        const v2 = tasks.filter((task) => task.backend === "v2")
        const next = v2.find(
          (task) => task.state === "admitted" || (task.state === "queued" && task.eligibility !== "cancelled"),
        )
        if (v2.length > 0 && (!next || next.eligibility !== "eligible")) return
        if (next && next.location_revision !== session.locationRevision) return
        const run = SessionRunner.Service.use((runner) =>
          runner.run({ sessionID, force, ...(next ? { taskInputID: next.input_id } : {}) }),
        ).pipe(
          Effect.provide(locations.get(location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
        if (!next) return yield* run
        const owned = SessionTaskOwner.withLease(
          database,
          {
            childSessionID: sessionID,
            inputID: next.input_id,
            onAcquired: (ownerGeneration) => {
              if (!exact.bind) throw new Error("Session coordinator is not ready")
              return exact.bind(sessionID, next.input_id, ownerGeneration)
            },
          },
          run,
        ).pipe(
          Effect.catch((error) =>
            error instanceof SessionTaskOwner.OwnerUnavailable || error instanceof SessionTaskOwner.LeaseLost
              ? Effect.logWarning("Task owner unavailable; child execution was not resumed", { sessionID })
              : Effect.die(error),
          ),
        )
        return yield* owned.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if ((yield* SessionTask.find(database.db, next.input_id))?.state !== "settled") return
              yield* SessionTaskResult.recordAndWake(database, events, wake, next.input_id)
              yield* SessionTaskScheduler.reassess(database, SessionSchema.ID.make(next.root_session_id), {
                wake: (child) => wake(child),
                executable: (child) =>
                  access.resolve(child).pipe(
                    Effect.map((resolution) => resolution.status === "resolved"),
                    Effect.catch(() => Effect.succeed(false)),
                  ),
              }).pipe(Effect.orDie)
            }),
          ),
        )
      }),
    })
    wake = coordinator.wake
    exact.bind = coordinator.bindExact

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      requestInterruptExact: (sessionID, inputID, ownerGeneration) =>
        Effect.sync(() => coordinator.requestInterruptExact(sessionID, inputID, ownerGeneration)),
      resume: coordinator.run,
      wake: coordinator.wake,
      wakeAndWait: coordinator.wakeAndWait,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, SessionLocationAccess.node, Database.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"

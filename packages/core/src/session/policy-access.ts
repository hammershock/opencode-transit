export * as SessionPolicyAccess from "./policy-access"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionLocationAccess } from "./location-access"
import { SessionLocationMutation } from "./location-mutation"
import { SessionPolicyStore } from "./policy"
import { SessionPolicyDeviceTable } from "./policy.sql"

export type Interface = ReturnType<typeof SessionPolicyStore.make>
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPolicyAccess") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const mutation = yield* SessionLocationMutation.Service
    const locations = yield* SessionLocationAccess.Service
    yield* database.db
      .insert(SessionPolicyDeviceTable)
      .values({ id: 1, device_id: crypto.randomUUID() })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const identity = yield* database.db
      .select()
      .from(SessionPolicyDeviceTable)
      .where(eq(SessionPolicyDeviceTable.id, 1))
      .get()
      .pipe(Effect.orDie)
    if (!identity?.device_id.trim())
      return yield* Effect.die(
        new SessionPolicyStore.Failure({
          kind: "unavailable",
          message: "Local policy identity is unavailable",
        }),
      )
    return Service.of(
      SessionPolicyStore.make({
        db: database.db,
        events,
        mutation,
        deviceID: identity.device_id,
        resolveLocation: (sessionID) => locations.require(sessionID),
      }),
    )
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionLocationAccess.node, SessionLocationMutation.node],
})

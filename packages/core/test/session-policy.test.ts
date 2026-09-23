import { expect, test } from "bun:test"
import { and, asc, eq, sql } from "drizzle-orm"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20260922185212_session-policy-review"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Location } from "../src/location"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionLocationMutation } from "../src/session/location-mutation"
import { SessionPolicyStore } from "../src/session/policy"
import { SessionPolicyActivationTable, SessionPolicyReviewTable } from "../src/session/policy.sql"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { SessionV1 } from "../src/v1/session"
import { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { EventManifest } from "@opencode-ai/schema/event-manifest"
import { SessionSyncDurable } from "@opencode-ai/schema/durable-event-manifest"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionLocationMutation.node]),
)
const it = testEffect(layer)

const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const mutation = yield* SessionLocationMutation.Service
  const sessionID = SessionSchema.ID.create()
  const info = SessionV1.SessionInfo.make({
    id: sessionID,
    slug: "policy",
    projectID: Project.ID.global,
    directory: "/project",
    title: "Policy",
    version: "test",
    time: { created: 0, updated: 0 },
    permission: [
      { permission: "read", pattern: "*.env", action: "ask" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/skills/*", action: "allow" },
      { permission: "read", pattern: "/archive/*", action: "allow" },
    ],
  })
  yield* events.publish(SessionV1.Event.Created, { sessionID, info })
  const resolveLocation = Effect.fn(function* (id: SessionSchema.ID) {
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
    if (!row) return yield* Effect.fail(new Error("Missing test Session"))
    return SessionPolicyStore.locationFromRow(row)
  })
  const make = (deviceID = "device-a", lock = mutation) =>
    SessionPolicyStore.make({
      db,
      events,
      mutation: lock,
      deviceID,
      resolveLocation,
    })
  const policy = make()
  const view = yield* policy.inspect(sessionID)
  const request: SessionPolicyStore.ReviewInput = {
    sessionID,
    requestID: "review-one",
    expectedRevision: view.revision,
    legacyDigest: view.legacyDigest,
    locationRevision: view.locationRevision,
    location: view.location,
    accepted: [true, false],
  }
  return { db, events, mutation, sessionID, info, policy, request, make, resolveLocation }
})

test("policy review is durable-internal, not a public tool/client event", () => {
  expect(SessionSyncDurable.definitions.get("session.policy.reviewed.1")).toBe(SessionPolicy.Reviewed)
  expect(EventManifest.Latest.has(SessionPolicy.Reviewed.type)).toBe(false)
})

it.live("inspects unknown allows without mutating history or legacy rules", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const view = yield* f.policy.inspect(f.sessionID)
    expect(view.status).toBe("pending")
    expect(view.rules).toEqual([
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "bash", resource: "*", effect: "deny" },
    ])
    expect((yield* f.db.select().from(SessionTable).get())?.permission).toEqual(f.info.permission)
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(1)
    expect(yield* f.db.select().from(SessionPolicyActivationTable).all()).toEqual([])
  }),
)

it.live("needs no review when legacy policy contains only restrictions", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.events.publish(SessionV1.Event.Updated, {
      sessionID: f.sessionID,
      info: { ...f.info, permission: f.info.permission?.slice(0, 2) },
    })
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("current")
    expect(yield* f.db.select().from(SessionPolicyReviewTable).all()).toEqual([])
  }),
)

it.live("accepts and drops individual allows, preserving order and original data", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const review = yield* f.policy.review(f.request)
    expect(review.revision).toBe(1)
    const view = yield* f.policy.inspect(f.sessionID)
    expect(view.status).toBe("reviewed")
    expect(view.rules).toEqual([
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "/skills/*", effect: "allow" },
    ])
    expect((yield* f.db.select().from(SessionTable).get())?.permission).toEqual(f.info.permission)
    expect((yield* f.make().inspect(f.sessionID)).status).toBe("reviewed")
    expect((yield* f.make("device-b").inspect(f.sessionID)).status).toBe("pending")
  }),
)

it.live("foreign reviews do not invalidate an unchanged local activation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    const foreign = f.make("device-b")
    const pending = yield* foreign.inspect(f.sessionID)
    expect(pending.status).toBe("pending")
    yield* foreign.review({
      ...f.request,
      requestID: "review-device-b",
      expectedRevision: pending.revision,
      legacyDigest: pending.legacyDigest,
      locationRevision: pending.locationRevision,
      location: pending.location,
    })

    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("reviewed")
    expect((yield* foreign.inspect(f.sessionID)).status).toBe("reviewed")
    expect((yield* f.policy.inspect(f.sessionID)).review?.deviceID).toBe("device-a")
    expect((yield* foreign.inspect(f.sessionID)).review?.deviceID).toBe("device-b")
  }),
)

it.live("review evidence without a basis epoch stays conservative", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    const row = yield* f.db.select().from(SessionPolicyReviewTable).get()
    if (!row || typeof row.data !== "object" || row.data === null) throw new Error("Missing review fixture")
    const { basisRevision: _, ...legacy } = row.data as SessionPolicy.Review & { basisRevision?: number }
    yield* f.db.update(SessionPolicyReviewTable).set({ data: legacy }).run()

    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("pending")
  }),
)

it.live("exact review retries return the original receipt and conflicting reuse fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.policy.review(f.request)
    expect(yield* f.policy.review(f.request)).toEqual(first)
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(2)
    expect((yield* Effect.flip(f.policy.review({ ...f.request, accepted: [false, true] }))).kind).toBe("conflict")
    expect(yield* f.db.select().from(SessionPolicyActivationTable).all()).toHaveLength(1)
  }),
)

it.live("two competing revisions have one winner", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const results = yield* Effect.all(
      [
        f.policy.review(f.request).pipe(Effect.exit),
        f.policy.review({ ...f.request, requestID: "review-two" }).pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    expect(yield* f.db.select().from(SessionPolicyReviewTable).all()).toHaveLength(1)
  }),
)

it.live("concurrent identical requests reconcile even with independent process locks", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const lock = yield* SessionLocationMutation.Service.pipe(Effect.provide(Layer.fresh(SessionLocationMutation.layer)))
    const results = yield* Effect.all([f.policy.review(f.request), f.make("device-a", lock).review(f.request)], {
      concurrency: "unbounded",
    })
    expect(results[0]).toEqual(results[1])
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(2)
  }),
)

it.live("identical legacy writes preserve review but A/B/A changes cannot revive it", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    yield* f.events.publish(SessionV1.Event.Updated, { sessionID: f.sessionID, info: { ...f.info, title: "Renamed" } })
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("reviewed")
    yield* f.events.publish(SessionV1.Event.Updated, {
      sessionID: f.sessionID,
      info: { ...f.info, permission: [{ permission: "read", pattern: "*", action: "deny" }] },
    })
    yield* f.events.publish(SessionV1.Event.Updated, { sessionID: f.sessionID, info: f.info })
    const view = yield* f.policy.inspect(f.sessionID)
    expect(view.legacyDigest).toBe(f.request.legacyDigest)
    expect(view.revision).toBe(3)
    expect(view.status).toBe("pending")
    expect(view.rules.every((rule) => rule.effect !== "allow")).toBe(true)
    expect((yield* Effect.flip(f.policy.review({ ...f.request, requestID: "stale" }))).kind).toBe("conflict")
  }),
)

it.live("rebind and legacy moves invalidate confirmation even when returning to the same path", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    yield* f.events.publish(SessionEvent.Moved, {
      sessionID: f.sessionID,
      timestamp: DateTime.makeUnsafe(1),
      location: Location.Ref.make({ directory: AbsolutePath.make("/other") }),
    })
    yield* f.events.publish(SessionEvent.Moved, {
      sessionID: f.sessionID,
      timestamp: DateTime.makeUnsafe(2),
      location: f.request.location,
    })
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("pending")
    expect((yield* f.policy.inspect(f.sessionID)).revision).toBe(3)
    yield* f.events.publish(SessionEvent.LocationRebound, {
      sessionID: f.sessionID,
      timestamp: DateTime.makeUnsafe(3),
      previous: f.request.location,
      location: f.request.location,
      revision: 1,
    })
    expect(
      (yield* Effect.flip(f.policy.review({ ...f.request, requestID: "old-location", expectedRevision: 3 }))).kind,
    ).toBe("conflict")
  }),
)

it.live("failed local activation rolls back the event and both projections", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.db.run(
      sql.raw(
        "CREATE TRIGGER reject_activation BEFORE INSERT ON session_policy_activation BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      ),
    )
    expect(Exit.isFailure(yield* f.policy.review(f.request).pipe(Effect.exit))).toBe(true)
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(1)
    expect(yield* f.db.select().from(SessionPolicyReviewTable).all()).toEqual([])
    expect(yield* f.db.select().from(SessionPolicyActivationTable).all()).toEqual([])
    expect((yield* f.policy.inspect(f.sessionID)).revision).toBe(0)
    yield* f.db.run(sql.raw("DROP TRIGGER reject_activation"))
    yield* f.policy.review(f.request)
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("reviewed")
  }),
)

it.live("late transactional validation rejects a changed policy and leaves no partial receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.events.project(SessionPolicy.Reviewed, () =>
      f.db
        .update(SessionTable)
        .set({ permission_revision: 100 })
        .where(eq(SessionTable.id, f.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    expect((yield* Effect.flip(f.policy.review(f.request))).kind).toBe("conflict")
    expect((yield* f.policy.inspect(f.sessionID)).revision).toBe(0)
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(1)
    expect(yield* f.db.select().from(SessionPolicyReviewTable).all()).toEqual([])
  }),
)

it.live("rejects malformed policy, stale digests and incomplete decisions without fallback", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    expect((yield* Effect.flip(f.policy.review({ ...f.request, accepted: [true] }))).kind).toBe("invalid-review")
    expect((yield* Effect.flip(f.policy.review({ ...f.request, legacyDigest: "wrong" }))).kind).toBe("conflict")
    yield* f.policy.review(f.request)
    yield* f.db
      .update(SessionPolicyReviewTable)
      .set({ data: { version: 2 } })
      .run()
    expect((yield* Effect.flip(f.policy.inspect(f.sessionID))).kind).toBe("unavailable")
  }),
)

it.live("unresolved Location and deleted Session cannot be reviewed", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const unresolved = SessionPolicyStore.make({
      db: f.db,
      events: f.events,
      mutation: f.mutation,
      deviceID: "device-a",
      resolveLocation: () => Effect.fail(new Error("Unresolved target")),
    })
    expect((yield* Effect.flip(unresolved.review(f.request))).kind).toBe("unavailable")
    yield* f.mutation.withLock(f.events.publish(SessionV1.Event.Deleted, { sessionID: f.sessionID, info: f.info }))
    expect((yield* Effect.flip(f.policy.review(f.request))).kind).toBe("not-found")
    expect(yield* f.db.select().from(SessionPolicyActivationTable).all()).toEqual([])
  }),
)

it.live("cancellation before commit leaves history unchanged and releases the mutation lock", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const blocked = SessionPolicyStore.make({
      db: f.db,
      events: f.events,
      mutation: f.mutation,
      deviceID: "device-a",
      resolveLocation: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return f.request.location
        }),
    })
    const running = yield* blocked.review(f.request).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(running)
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(1)
    yield* f.policy.review(f.request)
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("reviewed")
  }),
)

it.live("a missing target in a local activation receipt is not interpreted as local", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    yield* f.db
      .update(SessionPolicyActivationTable)
      .set({ location: { directory: "/project" } })
      .run()
    expect((yield* Effect.flip(f.policy.inspect(f.sessionID))).kind).toBe("unavailable")
  }),
)

it.live("additive migration preserves a populated old Session and is idempotent", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.db.run(sql.raw("DROP TABLE session_policy_activation"))
    yield* f.db.run(sql.raw("DROP TABLE session_policy_review"))
    yield* f.db.run(sql.raw("ALTER TABLE session DROP COLUMN permission_revision"))
    yield* f.db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
    yield* DatabaseMigration.applyOnly(f.db, [migration])
    yield* DatabaseMigration.applyOnly(f.db, [migration])
    expect((yield* f.db.select().from(SessionTable).get())?.permission).toEqual(f.info.permission)
    expect((yield* f.policy.inspect(f.sessionID)).revision).toBe(0)
    expect((yield* f.policy.inspect(f.sessionID)).status).toBe("pending")
    expect(yield* f.db.select().from(EventTable).all()).toHaveLength(1)
  }),
)

it.live("committed activation survives closing and reopening the database", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-policy-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    )
    const disk = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionLocationMutation.node]),
      [[Database.node, Database.layerFromPath(path.join(directory, "policy.db"))]],
    )
    const request = yield* Effect.gen(function* () {
      const f = yield* fixture
      yield* f.policy.review(f.request)
      return f.request
    }).pipe(Effect.provide(Layer.fresh(disk)))
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "policy.db")).exists())).toBe(true)
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const mutation = yield* SessionLocationMutation.Service
      const policy = SessionPolicyStore.make({
        db,
        events,
        mutation,
        deviceID: "device-a",
        resolveLocation: () => Effect.succeed(request.location),
      })
      expect((yield* policy.inspect(request.sessionID)).status).toBe("reviewed")
      expect((yield* policy.review(request)).revision).toBe(1)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
    }).pipe(Effect.provide(Layer.fresh(disk)))
  }),
)

it.live("replay preserves review evidence but never manufactures local activation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.policy.review(f.request)
    const history = (yield* f.db.select().from(EventTable).orderBy(asc(EventTable.seq)).all()).map((event) => ({
      id: event.id,
      aggregateID: event.aggregate_id,
      seq: event.seq,
      type: event.type,
      data: event.data,
    }))
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const mutation = yield* SessionLocationMutation.Service
      yield* events.replayAll(history)
      yield* events.replayAll(history)
      const policy = SessionPolicyStore.make({
        db,
        events,
        mutation,
        deviceID: "device-a",
        resolveLocation: () => Effect.succeed(f.request.location),
      })
      expect((yield* policy.inspect(f.sessionID)).status).toBe("pending")
      expect(yield* db.select().from(SessionPolicyReviewTable).all()).toHaveLength(1)
      expect(yield* db.select().from(SessionPolicyActivationTable).all()).toEqual([])
      expect((yield* Effect.flip(policy.review(f.request))).kind).toBe("conflict")
      expect(
        Exit.isFailure(yield* events.replay({ ...history[1], id: EventV2.ID.create(), seq: 10 }).pipe(Effect.exit)),
      ).toBe(true)
    }).pipe(Effect.provide(Layer.fresh(layer)))
  }),
)

it.live("forks remain pending and review evidence contains no device-local target ID", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const target = Location.RexdTarget.make({
      type: "rexd",
      targetID: Location.TargetID.make("a20c4f65-7ad8-47ae-bc91-7f2b9476108d"),
    })
    yield* f.db.update(SessionTable).set({ target }).where(eq(SessionTable.id, f.sessionID)).run()
    const view = yield* f.policy.inspect(f.sessionID)
    yield* f.policy.review({ ...f.request, location: view.location })
    const event = yield* f.db
      .select()
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, f.sessionID), eq(EventTable.type, "session.policy.reviewed.1")))
      .get()
    expect(JSON.stringify(event?.data)).not.toContain(target.targetID)
    expect(JSON.stringify(event?.data)).not.toContain("targetID")
    const child = SessionSchema.ID.create()
    yield* f.events.publish(SessionV1.Event.Created, {
      sessionID: child,
      info: { ...f.info, id: child, parentID: f.sessionID },
    })
    expect((yield* f.policy.inspect(child)).status).toBe("pending")
  }),
)

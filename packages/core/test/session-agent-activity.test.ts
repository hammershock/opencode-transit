import { expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAgentActivity } from "@opencode-ai/core/session/agent-activity"
import { SessionAgentWaitOwner } from "@opencode-ai/core/session/agent-wait-owner"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionAgentActivityTable, SessionAgentWaitTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

it.effect("keeps receiver order and fixes Wait ownership before replay", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const source = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
    const receiver = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values(
        [source, receiver].map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
        })),
      )
      .run()
      .pipe(Effect.orDie)
    yield* SessionPeerRoute.bind({
      sourceSessionID: receiver,
      targetSessionID: source,
      alias: "/root/worker",
      origin: { kind: "spawn", id: "activity-route" },
    })
    const publish = (kind: "reply" | "notice", operationID: string, activityWaitCallID?: string) =>
      Effect.gen(function* () {
        return yield* events.publish(SessionEvent.PeerMessageSent, {
          sessionID: receiver,
          sourceSessionID: source,
          messageID: SessionMessage.ID.create(),
          operationID,
          alias: "/contacts/requester",
          kind,
          text: "Private progress text",
          backend: "v2",
          queued: false,
          resume: false,
          ...(activityWaitCallID ? { activityWaitCallID } : {}),
          timestamp: yield* DateTime.now,
        })
      })
    const before = yield* publish("reply", "before-wait")
    yield* db
      .insert(SessionAgentWaitTable)
      .values({
        id: `${receiver}:wait-1`,
        call_id: "wait-1",
        session_id: receiver,
        targets: [source],
        state: "active",
        time_created: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    SessionAgentWaitOwner.start(`${receiver}:wait-1`)
    const duringOwner = yield* SessionAgentWaitOwner.withReceiver(receiver)(
      SessionAgentWaitOwner.current({ db, receiver, subject: source }),
    )
    expect(duringOwner).toBe("wait-1")
    const during = yield* publish("notice", "during-wait", duringOwner)
    yield* db
      .update(SessionAgentWaitTable)
      .set({ state: "finished", time_finished: Date.now() })
      .where(eq(SessionAgentWaitTable.id, `${receiver}:wait-1`))
      .run()
      .pipe(Effect.orDie)
    SessionAgentWaitOwner.finish(`${receiver}:wait-1`)
    yield* db
      .update(SessionAgentWaitTable)
      .set({ state: "active", time_finished: null })
      .where(eq(SessionAgentWaitTable.id, `${receiver}:wait-1`))
      .run()
      .pipe(Effect.orDie)
    expect(
      yield* SessionAgentWaitOwner.withReceiver(receiver)(
        SessionAgentWaitOwner.current({ db, receiver, subject: source }),
      ),
    ).toBeUndefined()
    const after = yield* publish("notice", "after-wait")
    const first = yield* SessionAgentActivity.page({ sessionID: receiver, limit: 2 })
    const second = yield* SessionAgentActivity.page({ sessionID: receiver, after: first.next ?? 0, limit: 2 })
    expect(first.activities.map((item) => item.id)).toEqual([before.id, during.id])
    expect(second.activities.map((item) => item.id)).toEqual([after.id])
    expect([...first.activities, ...second.activities].map((item) => item.waitCallID)).toEqual([null, "wait-1", null])
    expect([...first.activities, ...second.activities].map((item) => item.alias)).toEqual([
      "/root/worker",
      "/root/worker",
      "/root/worker",
    ])
    expect(JSON.stringify(first)).not.toContain("Private progress text")
    const projected = yield* db
      .select()
      .from(SessionAgentActivityTable)
      .where(eq(SessionAgentActivityTable.session_id, receiver))
      .all()
    expect(projected.map((item) => item.seq)).toEqual(projected.map((item) => item.seq).toSorted((a, b) => a - b))
    const durable = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, receiver)).all()
    yield* db.delete(SessionAgentActivityTable).where(eq(SessionAgentActivityTable.session_id, receiver)).run()
    yield* events.remove(receiver)
    for (const event of durable.toSorted((a, b) => a.seq - b.seq))
      yield* events.replay({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })
    expect(
      (yield* SessionAgentActivity.page({ sessionID: receiver })).activities.map((item) => item.waitCallID),
    ).toEqual([null, "wait-1", null])
    yield* db.delete(SessionTable).where(eq(SessionTable.id, receiver)).run().pipe(Effect.orDie)
    expect(
      yield* db
        .select()
        .from(SessionAgentActivityTable)
        .where(eq(SessionAgentActivityTable.session_id, receiver))
        .all(),
    ).toEqual([])
    expect(
      yield* db.select().from(SessionAgentWaitTable).where(eq(SessionAgentWaitTable.session_id, receiver)).all(),
    ).toEqual([])
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, source)).get()).toBeDefined()
  }),
)

it.effect("returns stable legacy and V2 part anchors for interleaved activity", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 4 }).run().pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values([
        {
          id: EventV2.ID.create(),
          aggregate_id: sessionID,
          seq: 0,
          type: "message.updated.1",
          data: { info: { id: "legacy", time: { completed: 4 } } },
        },
        {
          id: EventV2.ID.create(),
          aggregate_id: sessionID,
          seq: 1,
          type: "message.part.updated.1",
          data: { part: { id: "legacy-tool" } },
        },
        {
          id: EventV2.ID.create(),
          aggregate_id: sessionID,
          seq: 2,
          type: "session.next.tool.called.1",
          data: { callID: "v2-tool" },
        },
        {
          id: EventV2.ID.create(),
          aggregate_id: sessionID,
          seq: 3,
          type: "session.next.text.started.1",
          data: { textID: "v2-text" },
        },
        {
          id: EventV2.ID.create(),
          aggregate_id: sessionID,
          seq: 4,
          type: "session.next.step.ended.2",
          data: { assistantMessageID: "v2-assistant" },
        },
      ])
      .run()
      .pipe(Effect.orDie)
    const page = yield* SessionAgentActivity.page({ sessionID })
    expect(page.anchors).toEqual([
      { id: "legacy", seq: 0 },
      { id: "footer:legacy", seq: 0 },
      { id: "legacy-tool", seq: 1 },
      { id: "v2-tool", seq: 2 },
      { id: "v2-text", seq: 3 },
      { id: "footer:v2-assistant", seq: 4 },
    ])
  }),
)

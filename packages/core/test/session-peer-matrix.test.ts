import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionPeerMessage } from "@opencode-ai/core/session/peer-message"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionPeerMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

for (const sourceBackend of ["v1", "v2"] as const)
  for (const targetBackend of ["v1", "v2"] as const)
    it.effect(`${sourceBackend} → ${targetBackend} request and reply preserve native histories`, () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const source = SessionSchema.ID.create()
        const target = SessionSchema.ID.create()
        const now = Date.now()
        for (const id of [source, target])
          yield* events.publish(SessionV1.Event.Created, {
            sessionID: id,
            info: {
              id,
              projectID: Project.ID.global,
              directory: "/tmp/peer-matrix",
              slug: id,
              title: id,
              version: "test",
              time: { created: now, updated: now },
            },
          })
        for (const [id, backend] of [[source, sourceBackend], [target, targetBackend]] as const)
          if (backend === "v1")
            yield* events.publish(SessionV1.Event.MessageUpdated, {
              sessionID: id,
              info: {
                id: SessionV1.MessageID.make(`msg_${crypto.randomUUID().replaceAll("-", "")}`),
                sessionID: id,
                role: "user",
                agent: "build",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
                time: { created: now },
              },
            })
        yield* SessionPeerRoute.bind({
          sourceSessionID: source,
          targetSessionID: target,
          alias: "/root/worker",
          origin: { kind: "spawn", id: "matrix" },
        })
        const delivered: string[] = []
        const execution = SessionExecution.Service.of({
          active: Effect.succeed(new Set<SessionSchema.ID>()),
          resume: () => Effect.void,
          wake: () => Effect.void,
          wakeAndWait: () => Effect.void,
          interrupt: () => Effect.void,
          generation: () => Effect.succeed(undefined),
          interruptGeneration: () => Effect.succeed("completed" as const),
          requestInterruptExact: () => Effect.succeed(false),
          compactManual: () => Effect.void,
        })
        const deliverLegacy = (row: typeof SessionPeerMessageTable.$inferSelect) =>
          Effect.sync(() => { delivered.push(row.id) })
        const request = yield* SessionPeerMessage.send({
          sourceSessionID: source,
          alias: "/root/worker",
          text: "进展如何？请继续原任务。",
          operationID: `request-${sourceBackend}-${targetBackend}`,
          deliverLegacy,
        }).pipe(Effect.provideService(SessionExecution.Service, execution))
        expect(request.backend).toBe(targetBackend)
        expect(request.delivery).toBe("admitted")
        expect(delivered).toHaveLength(targetBackend === "v1" ? 1 : 0)
        expect(yield* SessionInput.hasPending(db, target, "steer")).toBe(targetBackend === "v2")
        const reply = yield* SessionPeerMessage.send({
          sourceSessionID: target,
          alias: `/contacts/requester_${source.slice(4, 16)}`,
          kind: "reply",
          replyTo: request.id,
          text: "7/20 已完成，继续执行。",
          operationID: `reply-${sourceBackend}-${targetBackend}`,
          deliverLegacy,
        }).pipe(Effect.provideService(SessionExecution.Service, execution))
        expect(reply.backend).toBe(sourceBackend)
        expect(reply.target_session_id).toBe(source)
        expect(reply.request_id).toBe(request.id)
        expect(delivered).toHaveLength((targetBackend === "v1" ? 1 : 0) + (sourceBackend === "v1" ? 1 : 0))
        expect(yield* SessionInput.hasPending(db, source, "steer")).toBe(sourceBackend === "v2")
        expect(
          (yield* db.select().from(SessionPeerMessageTable).where(eq(SessionPeerMessageTable.id, request.id)).get())
            ?.reply_id,
        ).toBe(reply.id)
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, target)).get()).toBeDefined()
      }),
    )

it.effect("nested routes and two requesters keep reply ownership separate", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const [a, b, c, d] = Array.from({ length: 4 }, () => SessionSchema.ID.create())
    const now = Date.now()
    for (const id of [a, b, c, d])
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: id,
        info: {
          id,
          projectID: Project.ID.global,
          directory: "/tmp/peer-requesters",
          slug: id,
          title: id,
          version: "test",
          time: { created: now, updated: now },
        },
      })
    yield* SessionPeerRoute.bind({
      sourceSessionID: a,
      targetSessionID: b,
      alias: "/root/worker",
      origin: { kind: "spawn", id: "a-spawns-b" },
    })
    yield* SessionPeerRoute.bind({
      sourceSessionID: b,
      targetSessionID: c,
      alias: "/root/nested",
      origin: { kind: "spawn", id: "b-spawns-c" },
    })
    const user = SessionMessage.ID.create()
    yield* SessionInput.admit(db, events, {
      id: user,
      sessionID: d,
      prompt: Prompt.make({ text: `Please connect ${b}` }),
      delivery: "steer",
    })
    yield* SessionPeerRoute.markUserMessage({ sessionID: d, messageID: user })
    yield* SessionPeerRoute.bind({
      sourceSessionID: d,
      targetSessionID: b,
      alias: "/root/existing",
      origin: { kind: "user_message", id: user },
    })
    expect((yield* SessionPeerRoute.list(a)).map((route) => route.target_session_id)).toEqual([b])
    expect((yield* SessionPeerRoute.list(b)).map((route) => route.target_session_id)).toContain(c)
    const execution = SessionExecution.Service.of({
      active: Effect.succeed(new Set<SessionSchema.ID>()),
      resume: () => Effect.void,
      wake: () => Effect.void,
      wakeAndWait: () => Effect.void,
      interrupt: () => Effect.void,
      generation: () => Effect.succeed(undefined),
      interruptGeneration: () => Effect.succeed("completed" as const),
      requestInterruptExact: () => Effect.succeed(false),
      compactManual: () => Effect.void,
    })
    const requestA = yield* SessionPeerMessage.send({
      sourceSessionID: a,
      alias: "/root/worker",
      text: "A asks for progress",
      operationID: "a-request",
    }).pipe(Effect.provideService(SessionExecution.Service, execution))
    const requestD = yield* SessionPeerMessage.send({
      sourceSessionID: d,
      alias: "/root/existing",
      text: "D asks for progress",
      operationID: "d-request",
    }).pipe(Effect.provideService(SessionExecution.Service, execution))
    const replyA = yield* SessionPeerMessage.send({
      sourceSessionID: b,
      alias: `/contacts/requester_${a.slice(4, 16)}`,
      kind: "reply",
      replyTo: requestA.id,
      text: "A-only result",
      operationID: "reply-a",
    }).pipe(Effect.provideService(SessionExecution.Service, execution))
    const replyD = yield* SessionPeerMessage.send({
      sourceSessionID: b,
      alias: `/contacts/requester_${d.slice(4, 16)}`,
      kind: "reply",
      replyTo: requestD.id,
      text: "D-only result",
      operationID: "reply-d",
    }).pipe(Effect.provideService(SessionExecution.Service, execution))
    expect([replyA.target_session_id, replyD.target_session_id]).toEqual([a, d])
    expect([replyA.request_id, replyD.request_id]).toEqual([requestA.id, requestD.id])
    expect((yield* SessionPeerMessage.openRequests(a)).some((row) => row.id === requestD.id)).toBe(false)
    expect((yield* SessionPeerMessage.openRequests(d)).some((row) => row.id === requestA.id)).toBe(false)
  }),
)

it.effect("deleting either Session never deletes its independent peer", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const source = SessionSchema.ID.create()
    const child = SessionSchema.ID.create()
    const now = Date.now()
    const info = (id: SessionSchema.ID) => ({
      id,
      projectID: Project.ID.global,
      directory: "/tmp/peer-deletion",
      slug: id,
      title: id,
      version: "test",
      time: { created: now, updated: now },
    })
    for (const id of [source, child])
      yield* events.publish(SessionV1.Event.Created, { sessionID: id, info: info(id) })
    yield* SessionPeerRoute.bind({
      sourceSessionID: source,
      targetSessionID: child,
      alias: "/root/worker",
      origin: { kind: "spawn", id: "spawn-before-delete" },
    })
    yield* events.publish(SessionV1.Event.Deleted, { sessionID: source, info: info(source) })
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, child)).get()).toBeDefined()
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, source)).get()).toBeUndefined()
    const other = SessionSchema.ID.create()
    yield* events.publish(SessionV1.Event.Created, { sessionID: other, info: info(other) })
    yield* SessionPeerRoute.bind({
      sourceSessionID: other,
      targetSessionID: child,
      alias: "/root/existing",
      origin: { kind: "spawn", id: "other-before-delete" },
    })
    yield* events.publish(SessionV1.Event.Deleted, { sessionID: child, info: info(child) })
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, other)).get()).toBeDefined()
    expect(
      (yield* Effect.exit(SessionPeerRoute.resolve({
        sourceSessionID: other,
        alias: "/root/existing",
        capability: "interact",
      })))._tag,
    ).toBe("Failure")
  }),
)

import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskWait } from "@opencode-ai/core/session/task-wait"
import { SessionTaskOwner } from "@opencode-ai/core/session/task-owner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Project } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionPolicyStore } from "@opencode-ai/core/session/policy"
import { QuestionV2 } from "@opencode-ai/core/question"
import { Prompt } from "@opencode-ai/schema/prompt"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const layer = Layer.merge(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])),
  buildLocationServiceMap(),
)

const scenario = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const root = SessionSchema.ID.create()
  const child = SessionSchema.ID.create()
  const input = SessionMessage.ID.create()
  const now = Date.now()
  const invocation = { parent_session_id: root, parent_message_id: "msg_parent", call_id: "call-task" }
  const info = {
    id: root,
    slug: "wait-root",
    projectID: Project.ID.global,
    directory: process.cwd(),
    title: "root",
    version: "test",
    time: { created: now, updated: now },
  }
  yield* events.publish(SessionV1.Event.Created, { sessionID: root, info })
  yield* events.publish(SessionV1.Event.Created, {
    sessionID: child,
    info: { ...info, id: child, slug: "wait-child", parentID: root },
    task: {
      inputID: input,
      rootSessionID: root,
      parentSessionID: root,
      parentMessageID: invocation.parent_message_id,
      callID: invocation.call_id,
      promptDigest: "a",
      childSessionID: child,
      description: "work",
      agentID: "build",
      locationRevision: 0,
      backend: "v2" as const,
    },
    taskInput: { messageID: input, prompt: Prompt.make({ text: "work" }), delivery: "queue" },
  })
  return { events, root, child, input, now, target: { task_id: child, invocation, input_id: input } }
})

describe("SessionTaskWait", () => {
  test("returns an already settled exact invocation and rejects a forged identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        yield* SessionTask.settle((yield* Database.Service).db, fixture.events, {
          childSessionID: fixture.child,
          inputID: fixture.input,
          outcome: "completed",
        })
        const receipt = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 100,
        })
        expect(receipt.reason).toBe("terminal")
        expect(receipt.data[0]?.input_id).toBe(fixture.input)
        expect(receipt.data[0]?.outcome).toBe("completed")
        const forged = yield* Effect.flip(
          SessionTaskWait.wait({
            parentSessionID: fixture.root,
            targets: [{ ...fixture.target, input_id: "msg_forged" }],
            timeoutMs: 100,
          }),
        )
        expect(forged).toBeInstanceOf(SessionTaskWait.UnknownOrForbidden)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("a bounded timeout leaves the child input admitted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const receipt = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 5,
        })
        expect(receipt.reason).toBe("timeout")
        expect(receipt.timed_out).toBe(true)
        expect((yield* SessionTask.find((yield* Database.Service).db, fixture.input))?.state).toBe("admitted")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("a newly admitted parent input ends wait without settling a queued child", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 2000,
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* fixture.events.publish(SessionEvent.PromptAdmitted, {
          sessionID: fixture.root,
          messageID: SessionMessage.ID.create(),
          prompt: Prompt.make({ text: "new user input" }),
          delivery: "steer",
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        const receipt = yield* Fiber.join(waiting)
        expect(receipt.reason).toBe("parent_input")
        expect(receipt.data[0]?.lifecycle).toBe("admitted")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("does not lose a settlement committed during the durable subscribe/replay handoff", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>()
        const continueRead = yield* Deferred.make<void>()
        let childID: string | undefined
        const hooked = makeGlobalNode({
          service: EventV2.Service,
          layer: EventV2.layerWith({
            beforeAggregateRead: (aggregateID) =>
              aggregateID === childID
                ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
                : Effect.void,
          }),
          deps: [Database.node],
        })
        const coordinated = Layer.merge(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
            [EventV2.node, hooked],
          ]),
          buildLocationServiceMap(),
        )
        yield* Effect.gen(function* () {
          const fixture = yield* scenario
          childID = fixture.child
          const waiting = yield* SessionTaskWait.wait({
            parentSessionID: fixture.root,
            targets: [fixture.target],
            timeoutMs: 2000,
          }).pipe(Effect.forkScoped)
          yield* Deferred.await(reading)
          yield* SessionTask.settle((yield* Database.Service).db, fixture.events, {
            childSessionID: fixture.child,
            inputID: fixture.input,
            outcome: "completed",
          })
          yield* Deferred.succeed(continueRead, undefined)
          const receipt = yield* Fiber.join(waiting)
          expect(receipt.reason).toBe("terminal")
          expect(receipt.data).toHaveLength(1)
          expect(receipt.data[0]?.input_id).toBe(fixture.input)
        }).pipe(Effect.provide(coordinated), Effect.scoped)
      }),
    )
  })

  test("interrupting a waiter releases owner listeners and leaves queued work intact", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "wait.sqlite")
    const fileLayer = Layer.merge(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(filename)],
      ]),
      buildLocationServiceMap(),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 2000,
        }).pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 1000 && !SessionTaskOwner.watcherCount(filename, fixture.child); attempt++)
          yield* Effect.yieldNow
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(1)
        yield* Fiber.interrupt(waiting)
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(0)
        expect((yield* SessionTask.find((yield* Database.Service).db, fixture.input))?.state).toBe("admitted")
      }).pipe(Effect.provide(fileLayer), Effect.scoped),
    )
  })

  test("owner acquisition rearms its one-shot watch and an admitted input still times out", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "owner-acquire.sqlite")
    const fileLayer = Layer.merge(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(filename)],
      ]),
      buildLocationServiceMap(),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const database = yield* Database.Service
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 300,
        }).pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 1000 && !SessionTaskOwner.watcherCount(filename, fixture.child); attempt++)
          yield* Effect.yieldNow
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(1)
        const ready = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const owner = yield* SessionTaskOwner.withLease(
          database,
          { childSessionID: fixture.child, inputID: fixture.input },
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(held))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(ready)
        const receipt = yield* Fiber.join(waiting)
        expect(receipt.reason).toBe("timeout")
        expect(receipt.data[0]?.lifecycle).toBe("admitted")
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(0)
        yield* Fiber.interrupt(owner)
      }).pipe(Effect.provide(fileLayer), Effect.scoped),
    )
  })

  test("a lost live owner wakes wait as unavailable without inventing a terminal outcome", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "owner-loss.sqlite")
    const fileLayer = Layer.merge(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(filename)],
      ]),
      buildLocationServiceMap(),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const database = yield* Database.Service
        const ownerReady = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const owner = yield* SessionTaskOwner.withLease(
          database,
          {
            childSessionID: fixture.child,
            inputID: fixture.input,
          },
          Deferred.succeed(ownerReady, undefined).pipe(Effect.andThen(Deferred.await(held))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(ownerReady)
        yield* fixture.events.publish(SessionTaskEvent.Promoted, {
          sessionID: fixture.child,
          inputID: fixture.input,
          timestamp: Date.now(),
        })
        const observed = yield* Effect.promise(() => SessionTaskOwner.observe(filename, fixture.child))
        expect(observed).toBeDefined()
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 2000,
        }).pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 1000 && !SessionTaskOwner.watcherCount(filename, fixture.child); attempt++)
          yield* Effect.yieldNow
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(1)
        process.kill(observed!.holder_pid, "SIGKILL")
        const receipt = yield* Fiber.join(waiting)
        expect(receipt.reason).toBe("unavailable")
        expect(receipt.data[0]?.lifecycle).toBe("active")
        expect(receipt.data[0]?.outcome).toBeUndefined()
        yield* Fiber.await(owner)
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(0)
      }).pipe(Effect.provide(fileLayer), Effect.scoped),
    )
  })

  test("live phase service failure reports unavailable instead of waiting for timeout", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "phase-failure.sqlite")
    const fileLayer = Layer.merge(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(filename)],
      ]),
      buildLocationServiceMap(),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const database = yield* Database.Service
        const locations = yield* LocationServiceMap.Service
        const ready = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const owner = yield* SessionTaskOwner.withLease(
          database,
          { childSessionID: fixture.child, inputID: fixture.input },
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(held))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(ready)
        yield* fixture.events.publish(SessionTaskEvent.Promoted, {
          sessionID: fixture.child,
          inputID: fixture.input,
          timestamp: Date.now(),
        })
        const unavailable = new Proxy(locations, {
          get: (target, key) =>
            key === "get"
              ? () => Layer.effect(QuestionV2.Service, Effect.fail(new Error("location unavailable")))
              : Reflect.get(target, key),
        })
        const started = Date.now()
        const failure = yield* Effect.flip(
          SessionTaskWait.wait({
            parentSessionID: fixture.root,
            targets: [fixture.target],
            timeoutMs: 1000,
          }).pipe(Effect.provideService(LocationServiceMap.Service, unavailable)),
        )
        expect(failure).toBeInstanceOf(SessionTaskWait.Unavailable)
        expect(Date.now() - started).toBeLessThan(500)
        yield* Fiber.interrupt(owner)
      }).pipe(Effect.provide(fileLayer), Effect.scoped),
    )
  })

  test("recognizes a real V2 question from the current invocation as needs_input", async () => {
    await using temp = await tmpdir()
    const filename = path.join(temp.path, "question.sqlite")
    const fileLayer = Layer.merge(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
        [Database.node, Database.layerFromPath(filename)],
      ]),
      buildLocationServiceMap(),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const database = yield* Database.Service
        const ownerReady = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const owner = yield* SessionTaskOwner.withLease(
          database,
          {
            childSessionID: fixture.child,
            inputID: fixture.input,
          },
          Deferred.succeed(ownerReady, undefined).pipe(Effect.andThen(Deferred.await(held))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(ownerReady)
        yield* fixture.events.publish(SessionEvent.Prompted, {
          sessionID: fixture.child,
          messageID: fixture.input,
          prompt: Prompt.make({ text: "work" }),
          delivery: "queue",
          timestamp: DateTime.makeUnsafe(fixture.now),
        })
        const promoted = yield* database.db
          .select({ seq: SessionInputTable.promoted_seq })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, fixture.input))
          .get()
        expect(promoted?.seq).toBeGreaterThanOrEqual(0)
        const assistantID = SessionMessage.ID.create()
        const assistant = Schema.encodeSync(SessionMessage.Message)(
          SessionMessage.Assistant.make({
            id: assistantID,
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            content: [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call-question",
                name: "question",
                state: SessionMessage.ToolStateRunning.make({
                  status: "running",
                  input: {},
                  structured: {},
                  content: [],
                }),
                time: { created: DateTime.makeUnsafe(fixture.now), ran: DateTime.makeUnsafe(fixture.now) },
              }),
            ],
            time: { created: DateTime.makeUnsafe(fixture.now) },
          }),
        )
        const { id: _, type, ...data } = assistant
        yield* database.db
          .insert(SessionMessageTable)
          .values({
            id: assistantID,
            session_id: fixture.child,
            type,
            seq: promoted!.seq! + 1,
            time_created: fixture.now,
            data,
          })
          .run()
        const child = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, fixture.child)).get()
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(SessionPolicyStore.locationFromRow(child!))
        const asked = yield* Deferred.make<void>()
        const unsubscribe = yield* fixture.events.listen((event) =>
          event.type === QuestionV2.Event.Asked.type
            ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target],
          timeoutMs: 1000,
        }).pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 1000 && !SessionTaskOwner.watcherCount(filename, fixture.child); attempt++)
          yield* Effect.yieldNow
        expect(SessionTaskOwner.watcherCount(filename, fixture.child)).toBe(1)
        const question = yield* Effect.gen(function* () {
          const service = yield* QuestionV2.Service
          return yield* service.ask({
            sessionID: fixture.child,
            questions: [],
            tool: { messageID: assistantID, callID: "call-question" },
          })
        }).pipe(Effect.provide(location), Effect.forkScoped)
        yield* Deferred.await(asked)
        const askedAt = Date.now()
        yield* unsubscribe
        const receipt = yield* Fiber.join(waiting)
        expect(receipt.reason).toBe("needs_input")
        expect(receipt.data[0]?.phase).toBe("question")
        expect(Date.now() - askedAt).toBeLessThan(500)
        yield* Fiber.interrupt(question)
        yield* Fiber.interrupt(owner)
      }).pipe(Effect.provide(fileLayer), Effect.scoped),
    )
  })

  test("keeps two child invocation identities separate when one settles", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* scenario
        const other = SessionSchema.ID.create()
        const otherInput = SessionMessage.ID.create()
        const now = Date.now()
        yield* fixture.events.publish(SessionV1.Event.Created, {
          sessionID: other,
          info: {
            id: other,
            slug: "wait-other",
            projectID: Project.ID.global,
            parentID: fixture.root,
            directory: process.cwd(),
            title: "other",
            version: "test",
            time: { created: now, updated: now },
          },
          task: {
            inputID: otherInput,
            rootSessionID: fixture.root,
            parentSessionID: fixture.root,
            parentMessageID: "msg_other_parent",
            callID: "call-other",
            promptDigest: "other",
            childSessionID: other,
            description: "other",
            agentID: "build",
            locationRevision: 0,
            backend: "v2",
          },
          taskInput: { messageID: otherInput, prompt: Prompt.make({ text: "other" }), delivery: "queue" },
        })
        const otherTarget = {
          task_id: other,
          input_id: otherInput,
          invocation: { parent_session_id: fixture.root, parent_message_id: "msg_other_parent", call_id: "call-other" },
        }
        const waiting = yield* SessionTaskWait.wait({
          parentSessionID: fixture.root,
          targets: [fixture.target, otherTarget],
          timeoutMs: 2000,
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* SessionTask.settle((yield* Database.Service).db, fixture.events, {
          childSessionID: other,
          inputID: otherInput,
          outcome: "completed",
        })
        const receipt = yield* Fiber.join(waiting)
        expect(receipt.reason).toBe("terminal")
        expect(receipt.data.map((view) => view.input_id)).toEqual([fixture.input, otherInput])
        expect(receipt.data.map((view) => view.outcome)).toEqual([undefined, "completed"])
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})

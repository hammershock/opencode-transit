import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { DateTime, Effect, Fiber, Layer, Option, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { ToolRegistry } from "@/tool/registry"
import { protectStatus } from "@/tool/task-status"
import { SessionTaskView } from "@opencode-ai/core/session/task-view"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Project } from "@opencode-ai/core/project"
import { Prompt } from "@opencode-ai/schema/prompt"
import { SessionTaskTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { SessionPeerMessage } from "@opencode-ai/core/session/peer-message"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionTask } from "@opencode-ai/core/session/task"
import {
  MessageTable,
  PartTable,
  SessionExecutionPauseTable,
  SessionInterruptionTable,
  SessionMessageTable,
  SessionPeerMessageTable,
} from "@opencode-ai/core/session/sql"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
  [LocationServiceMap.node, locationServiceMapLayer],
] as const

const it = testEffect(LayerNode.compile(root, replacements))
const withBackground = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })],
    [LocationServiceMap.node, locationServiceMapLayer],
  ]),
)
const withTaskBackend = testEffect(
  LayerNode.compile(
    LayerNode.group([ToolRegistry.node, Agent.node, Database.node, EventV2.node, SessionProjector.node]),
    [
      [Config.node, configLayer],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })],
      [LocationServiceMap.node, locationServiceMapLayer],
    ],
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(SessionTaskCapability.Service, {
        id: "session_v2",
        features: new Set<SessionTaskCapability.Feature>([
          "atomic_admission",
          "exact_owner_guard",
          "durable_queue",
          "reconcile",
          "exact_cancellation",
          "exact_result",
          "notification",
        ]),
      }),
    ),
  ),
)
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [LocationServiceMap.node, locationServiceMapLayer],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [LocationServiceMap.node, locationServiceMapLayer],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)
const withBrokenPlugin = testEffect(LayerNode.compile(root, [...replacements, [Plugin.node, brokenPluginLayer]]))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
      expect(ids).not.toContain("task_send")
      expect(ids).not.toContain("task_reconcile")
      expect(ids).not.toContain("task_wait")
      expect(ids).not.toContain("task_interrupt")
      expect(ids).not.toContain("task_stop")
    }),
  )

  withBackground.instance("does not advertise task_status from the incomplete legacy adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).not.toContain("task_status")
      expect(yield* registry.ids()).not.toContain("task_send")
      expect(yield* registry.ids()).not.toContain("task_reconcile")
      expect(yield* registry.ids()).not.toContain("task_wait")
      expect(yield* registry.ids()).not.toContain("task_interrupt")
      expect(yield* registry.ids()).not.toContain("task_stop")
    }),
  )

  withTaskBackend.instance("advertises six Agent tools without duplicate Task controls", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toEqual(
        expect.arrayContaining([
          "agent_spawn",
          "agent_connect",
          "agent_interact",
          "agent_inspect",
          "agent_wait",
          "agent_interrupt",
        ]),
      )
      expect(ids).not.toContain("task")
      expect(ids).not.toContain("task_status")
      expect(ids).not.toContain("task_send")
      expect(ids).not.toContain("task_wait")
      expect((yield* registry.all()).find((tool) => tool.id === "agent_spawn")?.description).toContain(
        "subagent_type must be an exact available subagent ID",
      )
      expect((yield* registry.all()).find((tool) => tool.id === "agent_interact")?.description).toContain(
        "A status of admitted means accepted for delivery, not delivered or processed",
      )
    }),
  )

  withTaskBackend.instance("agent_interact records an admitted V2 request under a readable alias", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const source = SessionSchema.ID.create()
      const target = SessionSchema.ID.create()
      const now = Date.now()
      const info = {
        id: source,
        slug: "agent-source",
        projectID: Project.ID.global,
        directory: process.cwd(),
        title: "agent source",
        version: "test",
        time: { created: now, updated: now },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: source, info })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: target,
        info: { ...info, id: target, slug: "agent-target" },
      })
      yield* SessionPeerRoute.bind({
        sourceSessionID: source,
        targetSessionID: target,
        alias: "/root/review",
        origin: { kind: "spawn", id: "agent-tool-test" },
      })
      const interact = (yield* registry.all()).find((tool) => tool.id === "agent_interact")
      expect(interact).toBeDefined()
      const output = yield* interact!
        .execute(
          { target: "/root/review", message: "What is done? Continue afterward." },
          {
            sessionID: SessionID.make(source),
            messageID: MessageID.make("msg_agent_tool"),
            callID: "call_interact",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.provide(SessionExecution.noopLayer))
      expect(output.title).toBe("Interacted with /root/review")
      expect(JSON.parse(output.output).status).toBe("admitted")
      const request = yield* database.db.select().from(SessionPeerMessageTable).get()
      expect(request).toBeDefined()
      yield* SessionPeerMessage.send({
        sourceSessionID: target,
        alias: `/contacts/requester_${source.slice(4, 16)}`,
        kind: "reply",
        replyTo: request!.id,
        text: "Three files reviewed; continuing.",
        operationID: "agent-tool-reply",
      }).pipe(Effect.provide(SessionExecution.noopLayer))
      const wait = (yield* registry.all()).find((tool) => tool.id === "agent_wait")
      expect(wait).toBeDefined()
      const waitContext: Tool.Context = {
        sessionID: SessionID.make(source),
        messageID: MessageID.make("msg_agent_wait"),
        callID: "call_wait",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const received = yield* wait!.execute({ aliases: ["/root/review"], timeout_ms: 1000 }, waitContext)
      expect(JSON.parse(received.output).reason).toBe("reply")
      expect(JSON.parse(received.output).data.text).toBe("Three files reviewed; continuing.")
      expect(yield* SessionInput.hasPending(database.db, source, "steer")).toBe(false)
      const repeated = yield* wait!.execute({ aliases: ["/root/review"], timeout_ms: 10 }, waitContext)
      expect(JSON.parse(repeated.output).timed_out).toBe(true)
      yield* database.db
        .insert(SessionInterruptionTable)
        .values({
          operation_id: "user-interrupt-review",
          session_id: target,
          backend: "v2",
          generation: "review-generation",
          actor_kind: "user",
          actor_id: "direct-user",
          state: "interrupted",
          time_requested: Date.now(),
          time_settled: Date.now(),
        })
        .run()
      yield* database.db
        .insert(SessionExecutionPauseTable)
        .values({
          session_id: target,
          operation_id: "user-interrupt-review",
          time_created: Date.now(),
        })
        .run()
      const inspect = (yield* registry.all()).find((tool) => tool.id === "agent_inspect")
      expect(inspect).toBeDefined()
      const observed = yield* inspect!.execute({ alias: "/root/review" }, waitContext)
      expect(JSON.parse(observed.output).agents[0]).toMatchObject({
        state: "interrupted",
        recent_execution: { status: "interrupted", actor: "user" },
      })
    }),
  )

  withTaskBackend.instance("agent_inspect treats unowned V1 and V2 tool calls as unknown", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const source = SessionSchema.ID.create()
      const v1 = SessionSchema.ID.create()
      const v2 = SessionSchema.ID.create()
      const now = Date.now()
      const info = {
        id: source,
        slug: "inspect-source",
        projectID: Project.ID.global,
        directory: process.cwd(),
        title: "inspect source",
        version: "test",
        time: { created: now, updated: now },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: source, info })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: v1,
        info: { ...info, id: v1, slug: "inspect-v1" },
      })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: v2,
        info: { ...info, id: v2, slug: "inspect-v2" },
      })
      yield* SessionPeerRoute.bind({
        sourceSessionID: source,
        targetSessionID: v1,
        alias: "/root/v1",
        origin: { kind: "spawn", id: "inspect-v1" },
      })
      yield* SessionPeerRoute.bind({
        sourceSessionID: source,
        targetSessionID: v2,
        alias: "/root/v2",
        origin: { kind: "spawn", id: "inspect-v2" },
      })
      const v1Message = MessageID.make("msg_inspect_v1")
      yield* database.db
        .insert(MessageTable)
        .values({
          id: v1Message,
          session_id: v1,
          time_created: now,
          data: { role: "assistant" } as typeof MessageTable.$inferInsert.data,
        })
        .run()
      yield* database.db
        .insert(PartTable)
        .values({
          id: "prt_inspect_v1" as typeof PartTable.$inferInsert.id,
          message_id: v1Message,
          session_id: v1,
          time_created: now,
          data: { type: "tool", tool: "bash", state: { status: "running" } } as typeof PartTable.$inferInsert.data,
        })
        .run()
      const v2Message = SessionMessage.ID.create()
      const assistant = Schema.encodeSync(SessionMessage.Message)(
        SessionMessage.Assistant.make({
          id: v2Message,
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call-inspect-v2",
              name: "bash",
              state: SessionMessage.ToolStateRunning.make({
                status: "running",
                input: {},
                structured: {},
                content: [],
              }),
              time: { created: DateTime.makeUnsafe(now), ran: DateTime.makeUnsafe(now) },
            }),
          ],
          time: { created: DateTime.makeUnsafe(now) },
        }),
      )
      const { id: _, type, ...data } = assistant
      yield* database.db
        .insert(SessionMessageTable)
        .values({
          id: v2Message,
          session_id: v2,
          type,
          seq: 1,
          time_created: now,
          data,
        })
        .run()
      const inspect = (yield* registry.all()).find((tool) => tool.id === "agent_inspect")!
      const context: Tool.Context = {
        sessionID: SessionID.make(source),
        messageID: MessageID.make("msg_inspect_source"),
        callID: "call_inspect",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      for (const alias of ["/root/v1", "/root/v2"]) {
        const output = yield* inspect.execute({ alias }, context).pipe(Effect.provide(SessionExecution.noopLayer))
        expect(JSON.parse(output.output).agents[0]).toMatchObject({
          state: "unknown",
          phase: "unknown",
          active_tools: [],
          tool_calls: { pending: 1 },
        })
      }
      expect(JSON.parse((yield* inspect.execute({ alias: "/root/v1" }, context)).output).agents[0]).toMatchObject({
        state: "unknown",
        phase: "unknown",
        active_tools: [],
      })
      yield* database.db
        .update(PartTable)
        .set({
          data: { type: "tool", tool: "bash", state: { status: "completed" } } as typeof PartTable.$inferInsert.data,
        })
        .where(eq(PartTable.message_id, v1Message))
        .run()
      expect(
        JSON.parse(
          (yield* inspect.execute({ alias: "/root/v1" }, context).pipe(Effect.provide(SessionExecution.noopLayer)))
            .output,
        ).agents[0],
      ).toMatchObject({
        state: "idle",
        active_tools: [],
        tool_calls: { pending: 0, completed: 1 },
      })
      yield* database.db
        .insert(SessionExecutionPauseTable)
        .values({
          session_id: v2,
          operation_id: "inspect-paused-v2",
          time_created: now,
        })
        .run()
      expect(
        JSON.parse(
          (yield* inspect.execute({ alias: "/root/v2" }, context).pipe(Effect.provide(SessionExecution.noopLayer)))
            .output,
        ).agents[0],
      ).toMatchObject({
        state: "interrupted",
        active_tools: [],
      })
    }),
  )

  withTaskBackend.instance("agent_wait claims an already completed Task result once", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const parent = SessionSchema.ID.create()
      const child = SessionSchema.ID.create()
      const inputID = SessionMessage.ID.create()
      const now = Date.now()
      const info = {
        id: parent,
        slug: "wait-parent",
        projectID: Project.ID.global,
        directory: process.cwd(),
        title: "wait parent",
        version: "test",
        time: { created: now, updated: now },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: parent, info })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: child,
        info: { ...info, id: child, slug: "wait-child", parentID: parent },
        task: {
          inputID,
          rootSessionID: parent,
          parentSessionID: parent,
          parentMessageID: "msg_wait_parent",
          callID: "call_spawn",
          promptDigest: "digest",
          childSessionID: child,
          description: "Review files",
          agentID: "build",
          locationRevision: 0,
          backend: "v2",
          background: true,
        },
        taskInput: { messageID: inputID, prompt: Prompt.make({ text: "Review files" }), delivery: "queue" },
      })
      yield* SessionPeerRoute.bind({
        sourceSessionID: parent,
        targetSessionID: child,
        alias: "/root/review",
        origin: { kind: "spawn", id: "call_spawn" },
      })
      yield* SessionTask.settle(database.db, events, { inputID, childSessionID: child, outcome: "completed" })
      const wait = (yield* registry.all()).find((tool) => tool.id === "agent_wait")
      expect(wait).toBeDefined()
      const context: Tool.Context = {
        sessionID: SessionID.make(parent),
        messageID: MessageID.make("msg_wait_parent"),
        callID: "call_wait",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const first = yield* wait!.execute({ aliases: ["/root/review"], timeout_ms: 1000 }, context)
      expect(JSON.parse(first.output)).toMatchObject({ reason: "completed", alias: "/root/review" })
      const second = yield* wait!.execute({ aliases: ["/root/review"], timeout_ms: 1000 }, context)
      expect(JSON.parse(second.output).timed_out).toBe(true)
    }),
  )

  withTaskBackend.instance("returns one bounded error for missing and foreign status targets", () =>
    Effect.gen(function* () {
      const status = (yield* (yield* ToolRegistry.Service).named()).taskStatus
      expect(status).toBeDefined()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_status_parent"),
        messageID: MessageID.make("msg_status_parent"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const first = yield* status!.execute({ target: { task_id: SessionID.make("ses_missing_a") } }, ctx)
      const second = yield* status!.execute({ target: { task_id: SessionID.make("ses_missing_b") } }, ctx)
      expect(first.output).toBe("task_target_unavailable")
      expect(second.output).toBe(first.output)
    }),
  )

  withTaskBackend.instance("returns a bounded wait error for an unknown exact child", () =>
    Effect.gen(function* () {
      const wait = (yield* (yield* ToolRegistry.Service).named()).taskWait
      expect(wait).toBeDefined()
      const parent = SessionID.make("ses_wait_parent")
      const output = yield* wait!.execute(
        {
          targets: [
            {
              task_id: SessionID.make("ses_missing"),
              input_id: "msg_missing",
              invocation: { parent_session_id: parent, parent_message_id: "msg_parent", call_id: "call-task" },
            },
          ],
          timeout_ms: 10,
        },
        {
          sessionID: parent,
          messageID: MessageID.make("msg_wait_parent"),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(output.output).toBe("task_unknown_or_forbidden")
    }),
  )

  withTaskBackend.instance("a pre-aborted model Task wait cancels without touching the child", () =>
    Effect.gen(function* () {
      const wait = (yield* (yield* ToolRegistry.Service).named()).taskWait
      expect(wait).toBeDefined()
      const parent = SessionID.make("ses_wait_parent")
      const controller = new AbortController()
      controller.abort()
      const output = yield* wait!.execute(
        {
          targets: [
            {
              task_id: SessionID.make("ses_missing"),
              input_id: "msg_missing",
              invocation: { parent_session_id: parent, parent_message_id: "msg_parent", call_id: "call-task" },
            },
          ],
          timeout_ms: 10_000,
        },
        {
          sessionID: parent,
          messageID: MessageID.make("msg_wait_parent"),
          agent: "build",
          abort: controller.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(output.output).toBe("task_wait_cancelled")
    }),
  )

  withTaskBackend.instance("an in-flight model Task wait stops on ctx.abort without cancelling its child", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const wait = (yield* (yield* ToolRegistry.Service).named()).taskWait
      expect(wait).toBeDefined()
      const parent = SessionSchema.ID.create()
      const child = SessionSchema.ID.create()
      const input = SessionMessage.ID.create()
      const now = Date.now()
      const info = {
        id: parent,
        slug: "wait-parent",
        projectID: Project.ID.global,
        directory: process.cwd(),
        title: "wait parent",
        version: "test",
        time: { created: now, updated: now },
      }
      yield* events.publish(SessionV1.Event.Created, { sessionID: parent, info })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: child,
        info: { ...info, id: child, slug: "wait-child", parentID: parent },
        task: {
          inputID: input,
          rootSessionID: parent,
          parentSessionID: parent,
          parentMessageID: "msg_parent",
          callID: "call-task",
          promptDigest: "digest",
          childSessionID: child,
          description: "work",
          agentID: "build",
          locationRevision: 0,
          backend: "v2" as const,
        },
        taskInput: { messageID: input, prompt: Prompt.make({ text: "work" }), delivery: "queue" },
      })
      const controller = new AbortController()
      const waiting = yield* wait!
        .execute(
          {
            targets: [
              {
                task_id: child,
                input_id: input,
                invocation: { parent_session_id: parent, parent_message_id: "msg_parent", call_id: "call-task" },
              },
            ],
            timeout_ms: 10_000,
          },
          {
            sessionID: parent,
            messageID: MessageID.make("msg_parent"),
            agent: "build",
            abort: controller.signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(Option.isNone(yield* Fiber.await(waiting).pipe(Effect.timeoutOption(10)))).toBe(true)
      controller.abort()
      const output = yield* Fiber.join(waiting)
      expect(output.output).toBe("task_wait_cancelled")
      const row = yield* database.db.select().from(SessionTaskTable).where(eq(SessionTaskTable.input_id, input)).get()
      expect(row?.state).toBe("admitted")
    }),
  )

  withTaskBackend.instance("does not disguise a storage defect as an unknown target", () =>
    Effect.gen(function* () {
      expect((yield* protectStatus(Effect.fail(new SessionTaskView.TargetUnavailable()))).output).toBe(
        "task_target_unavailable",
      )
      const broken = yield* protectStatus(Effect.die(new Error("database is closed: private path")))
      expect(broken.output).toBe("task_status_unavailable")
      expect(JSON.stringify(broken)).not.toContain("private path")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .opencode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("ignores non-tool exports in .opencode/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-opencode` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
    }),
  )

  it.instance("loads tools from .opencode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const opencode = path.join(test.directory, ".opencode")
        const customTools = path.join(opencode, "tools")
        const plugin = path.join(opencode, "node_modules", "@opencode-ai", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(opencode, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@opencode-ai/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".opencode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})

import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Effect } from "effect"
import { tmpdir } from "../../fixture/fixture"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

test("opening a running Task follows new child output past the initial message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = (id: string) => ({
    id,
    title: id === "parent" ? "Parent task" : "Child task",
    slug: id,
    approvalMode: id === "parent" ? "auto" : "normal",
    projectID: "project",
    directory: id === "child" ? `${directory}/child-project` : directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 30 },
    ...(id === "child" ? { parentID: "parent" } : {}),
  })
  const user = (sessionID: string, index: number) => ({
    info: {
      id: `${sessionID}-user-${index}`,
      sessionID,
      role: "user" as const,
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      time: { created: index * 2 + 1 },
    },
    parts: [
      {
        id: `${sessionID}-text-${index}`,
        sessionID,
        messageID: `${sessionID}-user-${index}`,
        type: "text" as const,
        text: `child step ${index}`,
      },
    ],
  })
  const childMessages = Array.from({ length: 25 }, (_, index) => user("child", index))
  const parentMessages = [
    user("parent", 0),
    {
      info: {
        id: "parent-assistant",
        sessionID: "parent",
        role: "assistant",
        agent: "build",
        modelID: "model",
        providerID: "test",
        mode: "build",
        parentID: "parent-user-0",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2 },
      },
      parts: [
        {
          id: "parent-task-part",
          sessionID: "parent",
          messageID: "parent-assistant",
          type: "tool",
          tool: "task",
          callID: "call-task",
          state: {
            status: "running",
            input: { description: "Inspect child", subagent_type: "general" },
            title: "Inspect child",
            metadata: {
              sessionId: "child",
              invocation: { parentMessageID: "parent-assistant", childMessageID: "child-user-0" },
            },
            time: { start: 2 },
          },
        },
      ],
    },
  ]
  const model = {
    id: "model",
    providerID: "test",
    api: { id: "model", url: "http://test", npm: "test" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 10_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  let interrupts = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/session/child/abort") {
      interrupts++
      return json(true)
    }
    if (url.pathname === "/agent")
      return json([
        {
          name: "build",
          mode: "primary",
          hidden: false,
          permission: [],
          options: {},
          model: { providerID: "test", modelID: "model" },
        },
      ])
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: { model } }],
        default: { test: "model" },
      })
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session") return json([session("parent")])
    if (url.pathname === "/session/status")
      return json(url.searchParams.get("directory") === session("child").directory
        ? { child: { type: "busy" } }
        : { parent: { type: "busy" } })
    if (url.pathname === "/session/parent" || url.pathname === "/session/child")
      return json(session(url.pathname.split("/")[2]!))
    if (url.pathname === "/session/parent/message") return json(parentMessages)
    if (url.pathname === "/session/child/message") return json(childMessages)
    if (/^\/session\/(parent|child)\/(todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname === "/api/session/parent" || url.pathname === "/api/session/child") {
      const id = url.pathname.split("/")[3]!
      return json({
        data: {
          id,
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 30 },
          title: session(id).title,
          location: { directory: session(id).directory },
          agent: "build",
          model: { providerID: "test", id: "model" },
        },
      })
    }
    if (/^\/api\/session\/(parent|child)\/message$/.test(url.pathname)) return json({ data: [], cursor: {} })
    if (/^\/api\/session\/(parent|child)\/target-resolution$/.test(url.pathname))
      return json({ status: "resolved", location: { directory } })
    if (/^\/api\/session\/(parent|child)\/activate$/.test(url.pathname))
      return json({ data: { status: "unchanged", diagnostics: [] } })
    if (/^\/api\/session\/(parent|child)\/model-context$/.test(url.pathname)) return json({})
  })
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
  let started!: () => void
  const ready = new Promise<void>((resolve) => (started = resolve))

  try {
    const { run } = await import("../../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            started()
          },
          async dispose() {
            disposeSlots()
          },
        },
      }).pipe(
        Effect.provide(
          Global.layerWith({ state: tmp.path, config: tmp.path, home: tmp.path, data: tmp.path, cache: tmp.path }),
        ),
      ),
    )
    await ready
    const deadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("Inspect child") && Date.now() < deadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    const lines = setup.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Inspect child"))
    expect(row).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(lines[row]!.indexOf("Inspect child") + 2, row)

    const childDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("child step 24") && Date.now() < childDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(setup.captureCharFrame()).toContain("child step 24")
    expect(setup.captureCharFrame()).toContain("auto (inherited)")
    expect(setup.captureCharFrame()).toContain("esc interrupt")
    const activityFrames = new Set<string>()
    const activityDeadline = Date.now() + 2_500
    while (Date.now() < activityDeadline) {
      await setup.renderOnce()
      activityFrames.add(setup.captureCharFrame().split("\n").find((line) => line.includes("esc interrupt")) ?? "")
      await Bun.sleep(100)
    }
    expect(activityFrames.has("")).toBe(false)
    expect(activityFrames.size).toBeGreaterThan(1)
    expect(setup.captureCharFrame()).toContain("Latest call")
    expect(setup.captureCharFrame()).toContain("no running tool observed")

    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_child_step_25",
        type: "message.updated",
        properties: { sessionID: "child", info: user("child", 25).info },
      },
    })
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_child_text_25",
        type: "message.part.updated",
        properties: { sessionID: "child", time: 52, part: user("child", 25).parts[0] },
      },
    })
    const updateDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("child step 25") && Date.now() < updateDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(setup.captureCharFrame()).toContain("child step 25")

    // A compatibility snapshot may already exist when canonical streaming starts.
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_child_snapshot",
        type: "message.part.updated",
        properties: {
          sessionID: "child",
          time: 53,
          part: {
            id: "child-live-text",
            messageID: "child-live",
            sessionID: "child",
            type: "text",
            text: "old snapshot",
          },
        },
      },
    })
    const emit = (payload: Parameters<typeof events.emit>[0]["payload"]) =>
      events.emit({ directory, project: "project", payload })
    emit({
      id: "evt_child_live_step",
      type: "session.next.step.started",
      properties: {
        sessionID: "child",
        assistantMessageID: "child-live",
        timestamp: 53,
        agent: "build",
        model: { providerID: "test", id: "model" },
      },
    })
    emit({
      id: "evt_child_reasoning_start",
      type: "session.next.reasoning.started",
      properties: {
        sessionID: "child",
        assistantMessageID: "child-live",
        timestamp: 54,
        reasoningID: "child-reasoning",
      },
    })
    emit({
      id: "evt_child_reasoning_delta",
      type: "session.next.reasoning.delta",
      properties: {
        sessionID: "child",
        assistantMessageID: "child-live",
        timestamp: 55,
        reasoningID: "child-reasoning",
        delta: "Inspecting the fixture",
      },
    })
    const thinkingDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("Thinking") && Date.now() < thinkingDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(setup.captureCharFrame()).toContain("Thinking")
    emit({
      id: "evt_child_reasoning_end",
      type: "session.next.reasoning.ended",
      properties: {
        sessionID: "child",
        assistantMessageID: "child-live",
        timestamp: 56,
        reasoningID: "child-reasoning",
        text: "Inspecting the fixture",
      },
    })
    emit({
      id: "evt_child_live_text_start",
      type: "session.next.text.started",
      properties: { sessionID: "child", assistantMessageID: "child-live", timestamp: 57, textID: "child-live-text" },
    })
    emit({
      id: "evt_child_live_text_delta",
      type: "session.next.text.delta",
      properties: {
        sessionID: "child",
        assistantMessageID: "child-live",
        timestamp: 58,
        textID: "child-live-text",
        delta: "Live child output is visible",
      },
    })
    const liveDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("Live child output is visible") && Date.now() < liveDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(setup.captureCharFrame()).toContain("Live child output is visible")
    expect(setup.captureCharFrame()).toContain("Thought")
    expect(setup.captureCharFrame()).not.toContain("Thinking")
    expect(setup.captureCharFrame()).not.toContain("old snapshot")

    emit({ id: "evt_child_idle", type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } })
    await Bun.sleep(30)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("esc interrupt")
    emit({ id: "evt_child_busy", type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } })
    await Bun.sleep(30)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("esc interrupt")
    setup.mockInput.pressEscape()
    await Bun.sleep(30)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("again to interrupt")
    expect(interrupts).toBe(0)
    setup.mockInput.pressEscape()
    const interruptDeadline = Date.now() + 2_000
    while (interrupts === 0 && Date.now() < interruptDeadline) await Bun.sleep(10)
    expect(interrupts).toBe(1)

    await setup.mockInput.typeText("A retained draft for history")
    await Bun.sleep(30)
    setup.mockInput.pressArrow("up")
    await Bun.sleep(30)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Live child output is visible")
    setup.mockInput.pressKey("c", { ctrl: true })
    await Bun.sleep(30)
    setup.mockInput.pressArrow("up")
    const parentDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("General Task — Inspect child") && Date.now() < parentDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    const parentLines = setup.captureCharFrame().split("\n")
    const parentRow = parentLines.findIndex((line) => line.includes("Inspect child"))
    expect(parentRow).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(parentLines[parentRow]!.indexOf("Inspect child") + 2, parentRow)
    const reopenDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("child step 25") && Date.now() < reopenDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(setup.captureCharFrame()).toContain("child step 25")

    api?.keymap.dispatchCommand("session.parent")
    const orderDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("Inspect child") && Date.now() < orderDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_parent_old_user",
        type: "session.next.prompted",
        durable: { aggregateID: "parent", seq: 1, version: 1 },
        properties: {
          sessionID: "parent",
          messageID: "msg_old_user",
          timestamp: 40,
          prompt: { text: "Old request" },
          delivery: "steer",
        },
      },
    })
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_parent_new_steer",
        type: "session.next.prompted",
        durable: { aggregateID: "parent", seq: 53, version: 1 },
        properties: {
          sessionID: "parent",
          messageID: "msg_new_steer",
          timestamp: 53,
          prompt: { text: "New steer request" },
          delivery: "steer",
        },
      },
    })
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_parent_old_assistant",
        type: "session.next.step.started",
        durable: { aggregateID: "parent", seq: 46, version: 1 },
        properties: {
          sessionID: "parent",
          assistantMessageID: "msg_old_assistant",
          timestamp: 60,
          agent: "build",
          model: { id: "model", providerID: "test" },
        },
      },
    })
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_parent_old_text_started",
        type: "session.next.text.started",
        durable: { aggregateID: "parent", seq: 47, version: 1 },
        properties: { sessionID: "parent", assistantMessageID: "msg_old_assistant", timestamp: 60, textID: "text-old" },
      },
    })
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_parent_old_text_ended",
        type: "session.next.text.ended",
        durable: { aggregateID: "parent", seq: 48, version: 1 },
        properties: {
          sessionID: "parent",
          assistantMessageID: "msg_old_assistant",
          timestamp: 60,
          textID: "text-old",
          text: "Older assistant output",
        },
      },
    })
    const steerDeadline = Date.now() + 5_000
    while (!setup.captureCharFrame().includes("New steer request") && Date.now() < steerDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    const orderLines = setup.captureCharFrame().split("\n")
    expect(orderLines.findIndex((line) => line.includes("Older assistant output"))).toBeGreaterThanOrEqual(0)
    expect(orderLines.findIndex((line) => line.includes("New steer request"))).toBeGreaterThan(
      orderLines.findIndex((line) => line.includes("Older assistant output")),
    )

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 20_000)

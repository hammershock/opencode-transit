import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

const PromptAdmissionRequest = Schema.Struct({
  id: Schema.String,
  prompt: Schema.Struct({
    text: Schema.String,
    skills: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        source: Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String }),
      }),
    ),
  }),
})

async function waitForFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}\n${setup.captureCharFrame()}`)
}

async function waitForFrameWithout(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
  timeout = 2_000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (!setup.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting to hide ${text}\n${setup.captureCharFrame()}`)
}

async function waitForEditor(setup: Awaited<ReturnType<typeof createTestRenderer>>, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const editor = setup.renderer.currentFocusedEditor
    if (editor instanceof TextareaRenderable) return editor
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for a focused textarea\n${setup.captureCharFrame()}`)
}

async function waitForEditorText(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const editor = setup.renderer.currentFocusedEditor
    if (editor instanceof TextareaRenderable && editor.plainText === text) return editor
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for editor text ${JSON.stringify(text)}`)
}

async function waitForSessionRequests(requests: URL[], count: number, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (requests.length >= count) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} Session list requests; observed ${requests.length}`)
}

async function waitForRequestCount(paths: string[], path: string, count: number, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (paths.filter((item) => item === path).length >= count) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} requests to ${path}`)
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
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
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test.each([
  { route: "QuickStart", args: {} },
  { route: "Session", args: { continue: true } },
] as const)("Ctrl+P opens the command palette from the production $route route", async ({ args }) => {
  let api: TuiPluginApi | undefined
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const patches: unknown[] = []
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/global/config" && request.method === "PATCH") {
      patches.push(await request.json())
      return json({ experimental: { subagent_economics: true } })
    }
    if (url.pathname === "/global/config") return json({ experimental: { subagent_economics: false } })
    if (url.pathname === "/session/dummy")
      return json({
        id: "dummy",
        title: "PromptRef integration",
        slug: "dummy",
        projectID: "project",
        directory,
        version: "0.0.0-test",
        time: { created: 0, updated: 0 },
      })
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "PromptRef integration",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args,
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    setup.mockInput.pressKey("home")
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForVisualIdle()

    expect(setup.captureCharFrame()).toContain("Commands")
    expect(
      api!.keymap
        .getCommandEntries({ visibility: "reachable", namespace: "palette" })
        .some((entry) => entry.command.name === "fork.location.recent"),
    ).toBe(!("continue" in args))
    const editor = await waitForEditor(setup)
    "Subagent economics".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "Configure device-local pricing")
    expect(editor.plainText).toBe("Subagent economics")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "○ saved off")
    expect(setup.captureCharFrame()).toContain("Device setting · give")
    setup.mockInput.pressKey(" ")
    await waitForFrame(setup, "● saved on")
    expect(patches).toEqual([{ experimental: { subagent_economics: true } }])
    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("Ctrl+P opens the production Skill Manager without a model turn", async () => {
  const setup = await createTestRenderer({ width: 100, height: 44, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const catalogRequests: URL[] = []
  const detailRequests: URL[] = []
  let scopeUpdates = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({
        path: "/tmp/opencode/targets.jsonc",
        revision: "target",
        targets: [],
        diagnostics: [],
        valid: true,
      })
    if (url.pathname === `/api/skill/skl_${"1".repeat(64)}`) {
      detailRequests.push(url)
      if (detailRequests.length > 1)
        return json(
          {
            _tag: "SkillNotFoundError",
            skillID: `skl_${"1".repeat(64)}`,
            message: "Skill is no longer available",
          },
          { status: 404 },
        )
      return json({
        location: { target: { type: "local" }, directory: "/tmp/opencode", project: { id: "test", directory } },
        data: {
          metadata: {
            id: `skl_${"1".repeat(64)}`,
            name: "review",
            description: "Review changes",
            sourceLabel: "OpenCode config",
            digest: "digest",
          },
          location: "/tmp/opencode/skills/review/SKILL.md",
          content: "# Review\n\nInspect the complete change before reporting.",
        },
      })
    }
    if (url.pathname.startsWith("/api/skill/settings/") && url.pathname.endsWith("/target-scope")) {
      scopeUpdates++
      return json({
        path: "/tmp/opencode/opencode.jsonc",
        revision: `settings-${scopeUpdates}`,
        roots: [
          {
            kind: "opencode-global",
            value: "/tmp/opencode/skills",
            resolved: "/tmp/opencode/skills",
            default: true,
            status: "ready",
          },
        ],
        targets: {},
        diagnostics: [],
        valid: true,
      })
    }
    if (url.pathname === "/api/skill/settings")
      return json({
        path: "/tmp/opencode/opencode.jsonc",
        revision: "settings",
        roots: [
          {
            kind: "opencode-global",
            value: "/tmp/opencode/skills",
            resolved: "/tmp/opencode/skills",
            default: true,
            status: "ready",
          },
        ],
        targets: {},
        diagnostics: [],
        valid: true,
      })
    if (url.pathname === "/api/skill/catalog") {
      catalogRequests.push(url)
      return json({
        location: { target: { type: "local" }, directory: "/tmp/opencode", project: { id: "test", directory } },
        data: {
          revision: "catalog",
          digest: "catalog",
          skills: [
            {
              id: `skl_${"1".repeat(64)}`,
              name: "review",
              description: "Review changes",
              sourceLabel: "OpenCode config",
              digest: "digest",
            },
          ],
          diagnostics: [],
        },
      })
    }
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let started!: () => void
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
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
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    await waitForEditor(setup, 5_000)
    expect(
      api?.keymap
        .getCommandEntries({ visibility: "reachable", namespace: "palette" })
        .map((entry) => entry.command.name),
    ).toContain("fork.skill.manage")
    const { getActiveCommandHost } = await import("../src/command-toolkit/host")
    expect(
      getActiveCommandHost(api!.keymap)
        ?.commands()
        .map((command) => command.identity),
    ).toContain("fork.skill.manage")
    const sessionRequests = calls.session.length
    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(setup, "Commands")
    await waitForEditor(setup)
    "Manage skills".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "Manage local discovery paths")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Discovery paths")

    const frame = setup.captureCharFrame()
    expect(frame).toContain("/tmp/opencode/skills")
    expect(frame).toContain("Source")
    expect(frame).toContain("Targets")
    expect(frame).toContain("State")
    expect(frame).toContain("● active")
    expect(frame).toContain("1 paths · 1 Skills")
    expect(catalogRequests.at(-1)?.searchParams.get("includeInactive")).toBe("true")
    expect(calls.session).toHaveLength(sessionRequests)

    // Skill Manager is owned by the route, so option models outlive this dialog.
    // Repainting a later dialog used to update the destroyed header TextBuffer.
    api!.ui.dialog.clear()
    await setup.waitForVisualIdle()
    await Bun.sleep(20)
    api!.keymap.dispatchCommand("theme.switch")
    await waitForFrame(setup, "Themes")
    api!.theme.set(api!.theme.selected === "aura" ? "ayu" : "aura")
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("TextBuffer is destroyed")
    api!.ui.dialog.clear()
    api!.keymap.dispatchCommand("fork.skill.manage")
    await waitForFrame(setup, "Discovery paths")
    expect(setup.captureCharFrame()).toContain("State")

    await waitForEditor(setup)
    await setup.mockInput.typeText("review")
    await waitForFrame(setup, "review")
    expect(setup.captureCharFrame()).toContain("View ctrl+o")
    setup.mockInput.pressKey("o", { ctrl: true })
    await waitForFrame(setup, "Skill · review")
    const previewFrame = setup.captureCharFrame()
    expect(previewFrame).toContain("Description  Review changes")
    expect(previewFrame).toContain("Entry        /tmp/opencode/skills/review/SKILL.md")
    expect(previewFrame).toContain("Inspect the complete change before reporting.")
    expect(previewFrame).toContain("copy c")
    expect(detailRequests).toHaveLength(1)
    setup.mockInput.pressEscape()
    await waitForFrame(setup, "Manage skills")
    expect(setup.captureCharFrame()).toContain("review")
    setup.mockInput.pressKey("o", { ctrl: true })
    await waitForFrame(setup, "Skill content unavailable")
    expect(setup.captureCharFrame()).toContain("Manage skills")
    expect(detailRequests).toHaveLength(2)
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Target access · review")
    const targetFrame = setup.captureCharFrame()
    expect(targetFrame).toContain("[ Confirm ] enter · space toggle")
    expect(targetFrame).not.toContain("Save target access")
    expect(targetFrame).not.toContain("Actions")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey(" ")
    await waitForFrame(setup, "[ ] local")
    expect(scopeUpdates).toBe(0)
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Target access saved")
    expect(scopeUpdates).toBe(1)

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("the production /subagent manager shows effective access and applies a Session override", async () => {
  const setup = await createTestRenderer({ width: 116, height: 36, useThread: false })
  const core = await import("@opentui/core")
  void mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const catalogRequests: URL[] = []
  const accessUpdates: unknown[] = []
  const definitionCreates: unknown[] = []
  const definitionUpdates: unknown[] = []
  const definitionDeletes: unknown[] = []
  let rejectAccess = true
  const session = {
    id: "dummy",
    title: "Subagent manager integration",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const entry = {
    id: "reviewer",
    name: "Reviewer",
    description: "Review changes and run focused checks",
    model: { providerID: "test", modelID: "reasoner" },
    effective: "active" as const,
    reason: "default" as const,
    approvalRequired: false,
    capabilities: ["read-only", "no-delegation"],
    editable: true,
    source: "global" as const,
  }
  const snapshot = (active: boolean, created?: { description?: string }) => ({
    location: { target: { type: "local" }, directory, project: { id: "project", directory } },
    data: {
      revision: active ? "revision-1" : "revision-2",
      parentAgentID: "build",
      sessionID: "dummy",
      entries: [
        {
          ...entry,
          effective: active ? ("active" as const) : ("inactive" as const),
          reason: active ? ("default" as const) : ("session" as const),
        },
        ...(created
          ? [
              {
                ...entry,
                id: "isolated-reviewer",
                name: "Isolated reviewer",
                description: created.description,
                model: undefined,
                effective: "active" as const,
                reason: "default" as const,
              },
            ]
          : []),
      ],
      diagnostics: [],
    },
  })
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "test",
            name: "Test",
            source: "custom",
            env: [],
            options: {},
            models: { reasoner: { id: "reasoner", name: "Reasoner", status: "active" } },
          },
        ],
        default: {},
      })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/api/session/dummy/activate") return json({ data: { status: "unchanged", diagnostics: [] } })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/api/subagent" && request.method === "GET") {
      catalogRequests.push(url)
      return json(snapshot(true))
    }
    if (url.pathname === "/api/subagent/access" && request.method === "PATCH") {
      accessUpdates.push(await request.json())
      if (rejectAccess) {
        rejectAccess = false
        return json({ message: "revision changed" }, { status: 409 })
      }
      return json(snapshot(false))
    }
    if (url.pathname === "/api/subagent/definition" && request.method === "POST") {
      definitionCreates.push(await request.json())
      return json(snapshot(false, {}))
    }
    if (url.pathname === "/api/subagent/definition/isolated-reviewer" && request.method === "PATCH") {
      definitionUpdates.push(await request.json())
      return json(snapshot(false, { description: "Temporary review agent" }))
    }
    if (url.pathname === "/api/subagent/definition/isolated-reviewer" && request.method === "DELETE") {
      definitionDeletes.push(await request.json())
      return json(snapshot(false))
    }
    return undefined
  })
  let started!: () => void
  let api: TuiPluginApi | undefined
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
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
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    api!.keymap.dispatchCommand("fork.subagent.manage")
    await waitForFrame(setup, "Subagents · build")
    await waitForFrame(setup, "test/reasoner")
    await Bun.sleep(300)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("●")
    expect(frame).toContain("Reviewer")
    expect(frame).toContain("test/reasoner")
    expect(frame).toContain("Read only")
    expect(frame).toContain("1/1 active")
    expect(catalogRequests).toHaveLength(1)
    expect(catalogRequests[0]?.searchParams.get("sessionID")).toBe("dummy")
    expect(catalogRequests[0]?.searchParams.get("parentAgentID")).toBe("build")
    expect(catalogRequests[0]?.searchParams.get("includeInactive")).toBe("true")

    setup.mockInput.pressKey(" ")
    await waitForFrame(setup, "Deactivate · Reviewer")
    expect(setup.captureCharFrame()).toContain("This session")
    expect(setup.captureCharFrame()).toContain("Globally")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Subagent change not saved")
    setup.mockInput.pressEscape()
    await waitForFrame(setup, "1/1 active")
    expect(catalogRequests).toHaveLength(2)

    setup.mockInput.pressKey(" ")
    await waitForFrame(setup, "Deactivate · Reviewer")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "0/1 active")
    expect(setup.captureCharFrame()).toContain("○")
    expect(setup.captureCharFrame()).not.toContain("● ○")
    expect(accessUpdates).toEqual(
      Array.from({ length: 2 }, () => ({
        sessionID: "dummy",
        parentAgentID: "build",
        expectedRevision: "revision-1",
        subagentID: "reviewer",
        active: false,
        scope: "session",
      })),
    )

    setup.mockInput.pressKey("a")
    await waitForFrame(setup, "Add subagent")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Name")
    await setup.mockInput.typeText("Isolated reviewer")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Isolated reviewer")
    setup.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(setup, "1/2 active")
    expect(definitionCreates).toEqual([
      {
        sessionID: "dummy",
        parentAgentID: "build",
        expectedRevision: "revision-2",
        definition: { name: "Isolated reviewer" },
      },
    ])

    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Edit subagent")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Description")
    await setup.mockInput.typeText("Temporary review agent")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Temporary review agent")
    setup.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(setup, "1/2 active")
    expect(definitionUpdates).toEqual([
      {
        sessionID: "dummy",
        parentAgentID: "build",
        expectedRevision: "revision-2",
        definition: { name: "Isolated reviewer", description: "Temporary review agent" },
      },
    ])

    setup.mockInput.pressKey("d")
    await waitForFrame(setup, "Delete · Isolated reviewer")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "0/1 active")
    expect(definitionDeletes).toEqual([{ sessionID: "dummy", parentAgentID: "build", expectedRevision: "revision-2" }])

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("the Harness command opens its keyboard-navigable controller instruction manager without a model turn", async () => {
  const setup = await createTestRenderer({ width: 64, height: 32, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const orphan = "22222222-2222-4222-8222-222222222222"
  const settings = {
    version: 1,
    path: "/tmp/opencode/harness.jsonc",
    home: "/tmp/controller-home",
    revision: "0".repeat(64),
    global: "policies/shared.md",
    targets: [
      { target: "local", reference: "policies/local.md" },
      { target: orphan, reference: "policies/shared.md" },
    ],
    diagnostics: [],
    valid: true,
  }
  let delaySettings = false
  let localBound = true
  let releaseSettings: (() => void) | undefined
  const calls = createFetch((url, request) => {
    if (url.pathname === "/api/target")
      return json({
        path: "/tmp/opencode/targets.jsonc",
        revision: "target",
        targets: [],
        diagnostics: [],
        valid: true,
      })
    if (url.pathname === "/api/harness/instructions") {
      if (!delaySettings)
        return json({
          ...settings,
          revision: localBound ? settings.revision : "1".repeat(64),
          targets: settings.targets.filter((item) => item.target !== "local" || localBound),
        })
      return new Promise<Response>((resolve) => {
        releaseSettings = () => resolve(json(settings))
      })
    }
    if (url.pathname === "/api/harness/instructions/global")
      return json({
        scope: { type: "global" },
        mode: "custom",
        source: {
          reference: "policies/shared.md",
          resolved: "/tmp/opencode/policies/shared.md",
          status: "readable",
          content: "shared policy",
          size: 13,
          digest: "shared-digest",
          truncated: true,
          sharedTargets: [orphan],
        },
        diagnostics: [],
      })
    if (url.pathname === "/api/harness/instructions/target/local")
      return json(
        localBound
          ? {
              scope: { type: "target", target: "local" },
              mode: "custom",
              source: {
                reference: "policies/local.md",
                resolved: "/tmp/opencode/policies/local.md",
                status: "readable",
                content: "local policy",
                size: 12,
                digest: "local-digest",
                sharedTargets: ["local"],
              },
              diagnostics: [],
            }
          : { scope: { type: "target", target: "local" }, mode: "default", diagnostics: [] },
      )
    if (url.pathname === "/api/harness/instructions/target/unbind" && request.method === "POST") {
      localBound = false
      return json({ ...settings, revision: "1".repeat(64), targets: settings.targets.slice(1) })
    }
    if (url.pathname === `/api/harness/instructions/target/${orphan}`)
      return json({
        scope: { type: "target", target: orphan },
        mode: "custom",
        source: {
          reference: "policies/shared.md",
          resolved: "/tmp/opencode/policies/shared.md",
          status: "readable",
          content: "shared policy",
          size: 13,
          digest: "shared-digest",
          sharedTargets: [orphan],
        },
        diagnostics: [],
      })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let started!: () => void
  let api: TuiPluginApi | undefined
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    const sessionRequests = calls.session.length
    api!.keymap.dispatchCommand("fork.harness.manage")
    await waitForFrame(setup, "Harness")
    expect(setup.captureCharFrame()).toContain("Instructions")
    expect(setup.captureCharFrame()).toContain("Skills")
    expect(setup.captureCharFrame()).not.toContain("Controller global and target rule files")
    expect(setup.captureCharFrame()).not.toContain("Existing discovery and target access manager")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Harness instructions")
    await waitForFrame(setup, "policies/local.md")
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Global rule")
    expect(frame).toContain("policies/shared.md")
    expect(frame).toContain("local")
    expect(frame).toContain("policies/local.md")
    expect(frame).toContain("Removed target 22222222")
    expect(frame).not.toContain("Back to Harness")
    expect(frame).not.toContain("Apply to this Session")
    expect(frame).not.toContain("Save ≠ Apply")
    expect(calls.session).toHaveLength(sessionRequests)

    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(setup, "Instructions · Global")
    expect(setup.captureCharFrame()).toContain("shared policy")
    expect(setup.captureCharFrame()).toContain("[preview truncated]")
    setup.mockInput.pressEscape()
    await waitForFrame(setup, "Harness instructions")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressBackspace()
    await waitForFrame(setup, "local path unset")
    expect(setup.captureCharFrame()).toMatch(/local\s+unset/)
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Controller instruction file")
    setup.mockInput.pressEscape()
    await waitForFrame(setup, "Harness instructions")
    expect(calls.session).toHaveLength(sessionRequests)
    setup.mockInput.pressEscape()
    await waitForFrameWithout(setup, "Harness instructions")
    expect(setup.captureCharFrame()).toContain("Harness")

    setup.mockInput.pressEscape()
    await waitForFrameWithout(setup, "Harness")
    delaySettings = true
    await Bun.sleep(20)
    api!.keymap.dispatchCommand("fork.harness.manage")
    await waitForFrame(setup, "Harness")
    await setup.waitForVisualIdle()
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Harness instructions")
    while (!releaseSettings) await Bun.sleep(10)
    setup.mockInput.pressEscape()
    await waitForFrameWithout(setup, "Harness instructions")
    expect(setup.captureCharFrame()).toContain("Harness")
    setup.mockInput.pressEscape()
    await waitForFrameWithout(setup, "Harness")
    releaseSettings()
    await Bun.sleep(50)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Harness instructions")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("QuickStart accepts and renders keyboard input without starving the keymap", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const keymapErrors: string[] = []
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
  let disposeErrors = () => {}

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            disposeErrors = input.api.keymap.on("error", (event) => keymapErrors.push(event.code))
            started()
          },
          async dispose() {
            disposeErrors()
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    const editor = await waitForEditor(setup)

    const input = "QuickStart remains responsive"
    input.split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, input, 2_000)

    expect(editor.plainText).toBe(input)

    api?.keymap.dispatchCommand("prompt.clear")
    await waitForFrame(setup, "Ask anything", 2_000)
    expect(editor.plainText).toBe("")
    const unknown = "/definitely-unknown"
    unknown.split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, unknown, 2_000)
    const sessionRequests = calls.session.length
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Slash command does not exist", 2_000)
    expect(editor.plainText).toBe(unknown)
    expect(calls.session.length).toBe(sessionRequests)

    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(setup, "Commands", 2_000)

    expect(keymapErrors).not.toContain("state-change-feedback-loop")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test.each([
  { width: 60, remote: false },
  { width: 100, remote: false },
  { width: 140, remote: false },
  { width: 100, remote: true },
])(
  "QuickStart recent locations select safely at $width columns (remote=$remote)",
  async ({ width, remote }) => {
    const setup = await createTestRenderer({ width, height: 30, useThread: false })
    const core = await import("@opentui/core")
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
    const events = createEventSource()
    const validated: URL[] = []
    let fail = true
    let release: (() => void) | undefined
    let delay = false
    let removed = false
    const prepared: string[] = []
    const calls = createFetch(async (url) => {
      if (url.pathname === "/api/target")
        return json({
          path: "targets.jsonc",
          revision: "test",
          targets: remote && !removed ? [{ id: "target-1", name: "renamed", workspaceRoots: ["/work"] }] : [],
          diagnostics: [],
          valid: true,
        })
      if (url.pathname === "/api/target/target-1/prepare") {
        prepared.push("target-1")
        return json({ status: "ready", stages: [] })
      }
      if (url.pathname === "/experimental/session") {
        expect(url.searchParams.has("directory")).toBe(false)
        return json(
          Array.from({ length: 25 }, (_, i) => ({
            id: `recent-${i}`,
            slug: `recent-${i}`,
            projectID: `project-${i}`,
            title: "Recent work",
            directory: `/work/project-${i}`,
            ...(remote ? { target: { type: "rexd", targetID: "target-1" }, lastKnownTargetName: "old-name" } : {}),
            version: "test",
            time: { created: 0, updated: 100 - i },
          })),
        )
      }
      if (url.pathname === "/api/fs/list") {
        validated.push(url)
        if (delay)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        if (fail) return json({ message: "Directory unavailable" }, { status: 400 })
        return json({ data: [] })
      }
      if (url.pathname === "/config/providers")
        return json({
          providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
          default: {},
        })
    })
    let api: TuiPluginApi | undefined
    let disposeSlots = () => {}
    try {
      const { run } = await import("../src/app")
      const task = Effect.runPromise(
        run({
          url: "http://test",
          directory,
          config: createTuiResolvedConfig({ plugin_enabled: {} }),
          fetch: calls.fetch,
          events: events.source,
          args: {},
          pluginHost: {
            async start(input) {
              api = input.api
              disposeSlots = input.runtime.setupSlots(input.api).dispose
            },
            async dispose() {
              disposeSlots()
            },
          },
        }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
      )
      const editor = await waitForEditor(setup, 5_000)
      await waitForFrame(setup, "/work/project-0")
      api!.keymap.dispatchCommand("prompt.clear")
      "draft remains".split("").forEach((key) => setup.mockInput.pressKey(key))
      await waitForFrame(setup, "draft remains")
      api!.keymap.dispatchCommand("fork.location.recent")
      await waitForFrame(setup, "Search target or directory")
      await setup.waitForVisualIdle()
      setup.mockInput.pressEnter()
      await waitForFrame(setup, "Cannot select recent location")
      expect(editor.plainText).toBe("draft remains")
      expect(setup.captureCharFrame()).toContain("Search target or directory")
      fail = false
      delay = true
      setup.mockInput.pressEnter()
      while (!release) await Bun.sleep(10)
      setup.mockInput.pressEscape()
      await waitForFrameWithout(setup, "Search target or directory")
      release()
      await Bun.sleep(40)
      await waitForEditor(setup)
      expect(editor.plainText).toBe("draft remains")
      expect(setup.captureCharFrame()).not.toContain("● selected")
      delay = false
      const lines = setup.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("/work/project-0"))
      await setup.mockMouse.click(lines[y].indexOf("/work/project-0") + 2, y)
      await waitForFrame(setup, "● selected")
      expect(validated).toHaveLength(3)
      expect(validated.map((url) => url.searchParams.get("location[directory]"))).toEqual(
        Array(3).fill("/work/project-0"),
      )
      expect(validated.map((url) => url.searchParams.get("location[target]"))).toEqual(
        Array(3).fill(remote ? "target-1" : null),
      )
      expect(prepared).toHaveLength(remote ? 3 : 0)
      expect(editor.plainText).toBe("draft remains")
      if (remote) {
        removed = true
        api!.keymap.dispatchCommand("fork.location.recent")
        await waitForFrame(setup, "Search target or directory")
        await setup.waitForVisualIdle()
        setup.mockInput.pressEnter()
        await waitForFrame(setup, "Target is no longer configured")
        expect(validated).toHaveLength(3)
        expect(editor.plainText).toBe("draft remains")
      }
      if (!remote) {
        api!.keymap.dispatchCommand("prompt.clear")
        "/recent".split("").forEach((key) => setup.mockInput.pressKey(key))
        await waitForFrame(setup, "Choose a recently used target")
        await setup.waitForVisualIdle()
        setup.mockInput.pressEnter()
        await waitForFrame(setup, "Search target or directory")
        expect(validated).toHaveLength(3)
      }
      process.emit("SIGHUP")
      await task
    } finally {
      release?.()
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    }
  },
  15_000,
)

test.each(["canonical", "mixed", "legacy", "reopened", "slash", "failed-submit"])(
  "session.undo/redo round-trips %s turns through one boundary",
  async (kind) => {
    const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
    const core = await import("@opentui/core")
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
    const events = createEventSource()
    const legacySession = {
      id: "dummy",
      title: "Skill undo",
      slug: "dummy",
      projectID: "project",
      directory,
      version: "0.0.0-test",
      time: { created: 0, updated: 10 },
    }
    const canonicalSession = {
      id: "dummy",
      projectID: "project",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 10 },
      title: "Skill undo",
      location: { directory },
      agent: "build",
      model: { providerID: "test", id: "model" },
      ...(kind === "reopened" ? { revert: { messageID: "msg_skill" } } : {}),
    }
    const model = {
      id: "model",
      providerID: "test",
      api: { id: "model", url: "http://test", npm: "test" },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
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
    const message = {
      id: "msg_skill",
      type: "user",
      text: "$review inspect this",
      time: { created: 10 },
      skills: [
        {
          source: { start: 0, end: 7, text: "$review" },
          snapshot: {
            id: "ski_snapshot",
            name: "review",
            digest: "a".repeat(64),
            source: { kind: "opencode-global", label: "OpenCode" },
            content: "private instructions",
            status: "loaded",
          },
        },
      ],
    }
    const previous = {
      ...message,
      id: "msg_previous_skill",
      text: "$review inspect earlier",
      time: { created: 5 },
    }
    const paths: string[] = []
    const requests: string[] = []
    let commitFails = kind === "failed-submit"
    const calls = createFetch(async (url, request) => {
      paths.push(url.pathname)
      requests.push(`${request.method} ${url.pathname}`)
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
        return json({
          path: "/tmp/opencode/targets.jsonc",
          revision: "test",
          targets: [],
          diagnostics: [],
          valid: true,
        })
      if (url.pathname === "/session/dummy") return json(legacySession)
      if (url.pathname === "/session/dummy/message" && request.method === "GET")
        return json(
          (kind === "canonical" ? [] : kind === "mixed" ? [previous] : [previous, message]).map((item) => ({
            info: {
              id: item.id,
              role: "user",
              sessionID: "dummy",
              agent: "build",
              model: { providerID: "test", modelID: "model" },
              time: item.time,
            },
            parts: [{ id: `${item.id}_text`, sessionID: "dummy", messageID: item.id, type: "text", text: item.text }],
          })),
        )
      if (url.pathname === "/session/dummy/message" && request.method === "POST") return json({})
      if (url.pathname === "/api/session/dummy") return json({ data: canonicalSession })
      if (url.pathname === "/api/session/dummy/message")
        return json({
          data: kind === "canonical" ? [message, previous] : kind === "mixed" ? [message] : [],
          cursor: {},
        })
      if (url.pathname === "/api/session/dummy/target-resolution")
        return json({ status: "resolved", location: { directory } })
      if (url.pathname === "/api/session/dummy/activate")
        return json({ data: { status: "unchanged", diagnostics: [] } })
      if (url.pathname === "/api/skill/catalog")
        return json({
          location: { directory, project: { id: "project", directory } },
          data: {
            revision: "catalog",
            digest: "catalog",
            skills: [
              {
                id: "skl_review",
                name: "review",
                description: "Review changes",
                sourceLabel: "OpenCode · deadbeef",
                digest: "a".repeat(64),
              },
            ],
            diagnostics: [],
          },
        })
      if (url.pathname === "/api/session/dummy/interrupt") return new Response(null, { status: 204 })
      if (url.pathname === "/session/dummy/abort") return json(true)
      if (url.pathname === "/api/session/dummy/revert/stage") return json({ data: await request.json() })
      if (url.pathname === "/api/session/dummy/revert/clear") {
        events.emit({
          directory,
          project: "project",
          payload: {
            id: "evt_clear",
            type: "session.next.revert.cleared",
            properties: { sessionID: "dummy", timestamp: 45 },
          },
        })
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session/dummy/revert/commit")
        return commitFails
          ? json({ message: "injected commit failure" }, { status: 500 })
          : new Response(null, { status: 204 })
      if (url.pathname === "/session") return json([legacySession])
    })
    let api: TuiPluginApi | undefined
    let disposeSlots = () => {}
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })

    try {
      const { run } = await import("../src/app")
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
        }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
      )

      await ready
      await waitForFrame(setup, previous.text, 5_000)
      const initialEditor = await waitForEditor(setup)
      if (kind === "reopened") {
        await waitForFrame(setup, "1 message reverted")
        events.emit({
          directory,
          project: "project",
          payload: { id: "evt_legacy_clear", type: "session.revert.updated", properties: { sessionID: "dummy" } },
        })
        await waitForFrameWithout(setup, "message reverted")
      }
      if (kind === "slash") {
        initialEditor.focus()
        initialEditor.insertText("/undo")
        await waitForFrame(setup, "/undo")
        setup.mockInput.pressEnter()
      } else {
        api?.keymap.dispatchCommand("session.undo")
      }
      const editor = await waitForEditorText(setup, message.text).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nRequests: ${paths.join(", ")}`)
      })

      expect(editor.plainText).toBe(message.text)
      expect(paths).toContain("/api/session/dummy/interrupt")
      expect(paths).toContain("/api/session/dummy/revert/stage")
      expect(paths).not.toContain("/session/dummy/revert")

      events.emit({
        directory,
        project: "project",
        payload: {
          id: "evt_revert",
          type: "session.next.revert.staged",
          properties: { timestamp: 20, sessionID: "dummy", revert: { messageID: message.id } },
        },
      })
      await waitForFrame(setup, "1 message reverted")
      api?.keymap.dispatchCommand("session.undo")
      const earlier = await waitForEditorText(setup, previous.text)

      expect(earlier.plainText).toBe(previous.text)
      expect(paths.filter((path) => path === "/api/session/dummy/interrupt")).toHaveLength(2)
      expect(paths.filter((path) => path === "/api/session/dummy/revert/stage")).toHaveLength(2)

      events.emit({
        directory,
        project: "project",
        payload: {
          id: "evt_previous_revert",
          type: "session.next.revert.staged",
          properties: { timestamp: 30, sessionID: "dummy", revert: { messageID: previous.id } },
        },
      })
      await waitForFrame(setup, "2 message reverted")
      api?.keymap.dispatchCommand("session.redo")
      await waitForRequestCount(paths, "/api/session/dummy/revert/stage", 3)

      events.emit({
        directory,
        project: "project",
        payload: {
          id: "evt_latest_revert",
          type: "session.next.revert.staged",
          properties: { timestamp: 40, sessionID: "dummy", revert: { messageID: message.id } },
        },
      })
      await waitForFrame(setup, "1 message reverted")
      api?.keymap.dispatchCommand("session.redo")
      await waitForFrameWithout(setup, "message reverted")
      const cleared = await waitForEditorText(setup, "")

      expect(cleared.plainText).toBe("")
      expect(paths).toContain("/api/session/dummy/revert/clear")
      expect(paths).not.toContain("/session/dummy/unrevert")

      api?.keymap.dispatchCommand("session.undo")
      await waitForRequestCount(paths, "/api/session/dummy/revert/stage", 4)
      events.emit({
        directory,
        project: "project",
        payload: {
          id: "evt_submit_revert",
          type: "session.next.revert.staged",
          properties: { timestamp: 50, sessionID: "dummy", revert: { messageID: message.id } },
        },
      })
      await waitForFrame(setup, "1 message reverted")
      api?.keymap.dispatchCommand("prompt.clear")
      const replacement = await waitForEditorText(setup, "")
      replacement.focus()
      replacement.insertText("continue")
      await waitForFrame(setup, "continue")
      setup.mockInput.pressEnter()
      if (kind === "failed-submit") {
        await waitForFrame(setup, "Failed to send prompt")
        expect((await waitForEditorText(setup, "continue")).plainText).toBe("continue")
        expect(requests).not.toContain("POST /session/dummy/message")
        commitFails = false
        setup.mockInput.pressEnter()
      }
      await waitForRequestCount(paths, "/api/session/dummy/revert/commit", 1).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nRequests: ${requests.join(", ")}`)
      })
      await waitForRequestCount(paths, "/session/dummy/message", 2)

      expect(requests.indexOf("POST /api/session/dummy/revert/commit")).toBeLessThan(
        requests.indexOf("POST /session/dummy/message"),
      )

      process.emit("SIGHUP")
      await task
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    }
  },
  10_000,
)

test("a failed Skill admission keeps the selected draft and retries its exact message once", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Skill retry",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 10 },
  }
  const model = {
    id: "model",
    providerID: "test",
    api: { id: "model", url: "http://test", npm: "test" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
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
  const prompts: (typeof PromptAdmissionRequest.Type)[] = []
  const calls = createFetch(async (url, request) => {
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
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: { model } }],
        default: { test: "model" },
      })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/session/dummy/message") return json([])
    if (url.pathname === "/api/session/dummy")
      return json({
        data: {
          id: "dummy",
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 10 },
          title: "Skill retry",
          location: { directory },
          agent: "build",
          model: { providerID: "test", id: "model" },
        },
      })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/api/session/dummy/activate") return json({ data: { status: "unchanged", diagnostics: [] } })
    if (url.pathname === "/api/session/dummy/model-context")
      return json({
        skillCatalog: {
          skills: [
            {
              id: "skl_review",
              name: "review",
              sourceLabel: "OpenCode",
              digest: "a".repeat(64),
            },
          ],
        },
      })
    if (url.pathname === "/api/skill/catalog")
      return json({
        location: { directory, project: { id: "project", directory } },
        data: {
          revision: "catalog",
          digest: "catalog",
          skills: [
            {
              id: "skl_review",
              name: "review",
              description: "Review changes",
              sourceLabel: "OpenCode",
              digest: "a".repeat(64),
            },
          ],
          diagnostics: [],
        },
      })
    if (url.pathname === "/api/session/dummy/prompt") {
      prompts.push(Schema.decodeUnknownSync(PromptAdmissionRequest)(await request.json()))
      if (prompts.length === 1) return json({ message: "temporary admission failure" }, { status: 503 })
      if (prompts.length === 2)
        return json(
          {
            _tag: "SkillMentionError",
            message: "The selected Skill changed",
            kind: "stale-catalog",
            skillID: "skl_review",
            name: "review",
          },
          { status: 400 },
        )
      return json({ data: { id: "inp_retry", sequence: 1, status: "pending" } })
    }
    if (url.pathname === "/session") return json([session])
    return undefined
  })
  let disposeSlots = () => {}
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
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
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            started()
          },
          async dispose() {
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await waitForFrame(setup, "Build · Test Model")
    const editor = await waitForEditor(setup)
    editor.focus()
    setup.mockInput.pressKey("$")
    await waitForFrame(setup, "$review")
    setup.mockInput.pressTab()
    await waitForEditorText(setup, "$review ")
    editor.insertText("inspect this draft")
    const draft = "$review inspect this draft"
    await waitForFrame(setup, draft)
    editor.cursorOffset = 10
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Failed to send prompt")

    expect(editor.plainText).toBe(draft)
    expect(editor.cursorOffset).toBe(10)
    expect(editor.focused).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.prompt.skills).toEqual([
      { id: "skl_review", name: "review", source: { start: 0, end: 7, text: "$review" } },
    ])

    await Bun.sleep(20)
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Skill changed; select it again")

    expect(editor.plainText).toBe(draft)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]!.id).toBe(prompts[0]!.id)

    setup.mockInput.pressTab()
    await waitForEditorText(setup, draft)
    await Bun.sleep(20)
    setup.mockInput.pressEnter()
    await waitForEditorText(setup, "")

    expect(prompts).toHaveLength(3)
    expect(prompts[2]!.id).toBe(prompts[0]!.id)

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("a read-only Session keeps its draft while blocking Agent submission and allowing exit", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Read-only prompt",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    target: { type: "rexd", targetID: "missing-target" },
    time: { created: 0, updated: 0 },
  }
  const paths: string[] = []
  const calls = createFetch((url) => {
    paths.push(url.pathname)
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({
        status: "missing_local_target",
        missingTargetID: "missing-target",
        lastKnownTargetName: "offline",
        referencedSessionIDs: ["dummy"],
        location: { directory, target: session.target },
      })
    if (url.pathname === "/session") return json([session])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposeSlots = () => {}
  let task: Promise<unknown> | undefined

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            started()
          },
          async dispose() {
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await waitForFrame(setup, "Open read-only")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Draft editing is")
    const editor = await waitForEditor(setup)

    const draft = "keep this draft"
    editor.setText(draft)
    editor.focus()
    await waitForFrame(setup, draft)
    const promptRequests = paths.filter((item) => item.includes("/session/dummy/message")).length
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")

    expect(editor.plainText).toBe(draft)
    expect(paths.filter((item) => item.includes("/session/dummy/message"))).toHaveLength(promptRequests)

    editor.setText("@file")
    await setup.renderOnce()
    await Bun.sleep(20)
    expect(paths.some((item) => item.includes("/api/fs"))).toBe(false)

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    "permissions".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/permissions")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")
    expect(editor.plainText).toBe("/permissions")

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    "new".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/new")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")
    expect(editor.plainText).toBe("/new")

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    await waitForFrame(setup, "/context")
    expect(setup.captureCharFrame()).not.toContain("/agents")
    "quit".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/quit")
    setup.mockInput.pressEnter()
    await task
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) {
      process.emit("SIGHUP")
      await task
    }
    mock.restore()
  }
}, 10_000)

test("an open session waits for confirmation before returning home after deletion", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Deleted elsewhere",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session") return json([session])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    events.emit({
      directory,
      project: "proj_test",
      payload: { id: "evt_deleted", type: "session.deleted", properties: { sessionID: session.id, info: session } },
    })
    await setup.waitForVisualIdle()

    expect(setup.captureCharFrame()).toContain("Session deleted")
    expect(setup.captureCharFrame()).toContain("This session is no longer available.")

    setup.mockInput.pressEnter()
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("Session deleted")
    expect(setup.captureCharFrame()).toContain("Sync")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("an open session distinguishes scoped omission from a remotely projected deletion", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Deleted on another device",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  let listed = true
  let present = true
  const sessionRequests: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") {
      sessionRequests.push(url.pathname)
      return present
        ? json(session)
        : json({ name: "NotFoundError", data: { message: "Session not found" } }, { status: 404 })
    }
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session") return json(listed ? [session] : [])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    listed = false
    const initialRequests = sessionRequests.length
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection", type: "sync.projection.updated", properties: { revision: 1 } },
    })
    await waitForSessionRequests(calls.session, 2)
    await waitForRequestCount(sessionRequests, "/session/dummy", initialRequests + 1)
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("Session deleted")

    present = false
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection_deleted", type: "sync.projection.updated", properties: { revision: 2 } },
    })
    await waitForFrame(setup, "Session deleted")

    expect(setup.captureCharFrame()).toContain("This session is no longer available.")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Sync")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("an open Sessions dialog refreshes when another device projects a Session", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const first = {
    id: "first",
    title: "Existing session",
    slug: "first",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 1 },
  }
  const second = {
    ...first,
    id: "second",
    slug: "second",
    title: "Created on mywindows",
    time: { created: 2, updated: 2 },
  }
  let sessions = [first]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session") return json(sessions)
    if (url.pathname === "/global/sync/status") return json({ configured: true, deviceID: "mac" })
    if (url.pathname === "/global/sync/sessions") return json([])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    api?.keymap.dispatchCommand("session.list")
    await waitForFrame(setup, "Sessions")
    await setup.waitForVisualIdle()
    const initialRequests = calls.session.length
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection_initial", type: "sync.projection.updated", properties: { revision: 1 } },
    })
    await waitForSessionRequests(calls.session, initialRequests + 1)
    await waitForFrame(setup, "Existing session")
    sessions = [first, second]
    const secondRequests = calls.session.length
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection_second", type: "sync.projection.updated", properties: { revision: 2 } },
    })
    await waitForSessionRequests(calls.session, secondRequests + 1)
    await waitForFrame(setup, "Created on mywindows")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("event subscriber failure preserves production command palette rendering and search", async () => {
  let api: TuiPluginApi | undefined
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/dummy/activate") return json({ data: { status: "unchanged", diagnostics: [] } })
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/global/config") return json({ experimental: { subagent_economics: false } })
    if (url.pathname === "/session/dummy")
      return json({
        id: "dummy",
        title: "PromptRef integration",
        slug: "dummy",
        projectID: "project",
        directory,
        version: "0.0.0-test",
        time: { created: 0, updated: 0 },
      })
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "PromptRef integration",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
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
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    {
      const off = api!.event.on("session.status", () => {
        throw new Error("fixture event subscriber failed")
      })
      try {
        events.emit({
          directory,
          payload: {
            id: "event-fault",
            type: "session.status",
            properties: { sessionID: "dummy", status: { type: "busy" } },
          },
        })
      } catch {}
      off()
      await setup.waitForVisualIdle()
    }
    setup.mockInput.pressKey("home")
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForVisualIdle()

    expect(setup.captureCharFrame()).toContain("Commands")
    const editor = await waitForEditor(setup)
    "Subagent economics".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "Configure device-local pricing")
    expect(editor.plainText).toBe("Subagent economics")
    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

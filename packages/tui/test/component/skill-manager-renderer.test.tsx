/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { useSkillManager } from "../../src/component/skill-manager"
import { SkillSettings } from "@opencode-ai/core/skill/settings"
import { Skill } from "../../../schema/src/skill"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { KVProvider } from "../../src/context/kv"
import { RemoteStatusProvider } from "../../src/context/remote-status"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { eventSource, json } from "../fixture/tui-sdk"
import { testRenderExclusive } from "../fixture/tui-renderer"

const skillID = `skl_${"1".repeat(64)}`

test("separates path editing and reload from target scope saves", async () => {
  await using tmp = await tmpdir()
  const mounted = await mount(tmp.path)
  const app = mounted.app
  try {
    await waitFor(app, () => app.captureCharFrame().includes("review"))
    expect(app.captureCharFrame()).not.toContain("Import Codex")
    expect(app.captureCharFrame()).toContain("paths ctrl+p")
    expect(app.captureCharFrame()).toContain("reload ctrl+r")
    app.mockInput.pressKey("p", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).toContain("Skill paths · local")
    expect(app.captureCharFrame()).toContain("! unavailable")
    expect(app.captureCharFrame()).toContain("not a directory")
    if (process.env.SKILL_UI_EVIDENCE)
      await Bun.write(`${process.env.SKILL_UI_EVIDENCE}/paths.txt`, app.captureCharFrame())

    app.mockInput.pressKey("a", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).toContain("Add Skill path")
    await app.mockInput.typeText("/completed")
    app.mockInput.pressTab()
    await waitFor(app, () => mounted.requests.some((request) => new URL(request.url).pathname.endsWith("/fs/list")))
    await settle(app)
    expect(app.captureCharFrame()).toContain("/completed/")
    expect(mounted.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
    app.mockInput.pressEnter()
    await waitFor(app, () => mounted.requests.some((request) => request.method === "PUT"))
    await waitFor(
      app,
      () =>
        mounted.requests.filter((request) => new URL(request.url).searchParams.get("forceReload") === "true").length ===
        1,
    )
    await settle(app)
    expect(app.captureCharFrame()).toContain("Skill paths · local")

    await app.mockInput.typeText("completed")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Edit Skill path")
    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText("/edited")
    app.mockInput.pressEnter()
    await waitFor(app, () => mounted.requests.filter((request) => request.method === "PUT").length === 2)
    await settle(app)
    expect((await mounted.settings.load()).roots.some((root) => root.value === "/edited")).toBe(true)

    // Clear the filter, then locate the original unavailable entry and remove only its reference.
    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText("broken-file")
    await settle(app)
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, () => mounted.requests.filter((request) => request.method === "PUT").length === 3)
    await settle(app)
    expect((await mounted.settings.load()).roots.some((root) => root.value === mounted.broken)).toBe(false)
    expect(await Bun.file(mounted.broken).text()).toBe("keep")

    app.mockInput.pressEscape()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Manage skills")
    if (process.env.SKILL_UI_EVIDENCE)
      await Bun.write(`${process.env.SKILL_UI_EVIDENCE}/skills.txt`, app.captureCharFrame())
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    await settle(app)
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Target access · review")
    const reloads = mounted.requests.filter(
      (request) => new URL(request.url).searchParams.get("forceReload") === "true",
    ).length
    app.mockInput.pressKey(" ")
    app.mockInput.pressEnter()
    await waitFor(app, () =>
      mounted.requests.some((request) => new URL(request.url).pathname.endsWith("/target-scope")),
    )
    await settle(app)
    expect(
      mounted.requests.filter((request) => new URL(request.url).searchParams.get("forceReload") === "true"),
    ).toHaveLength(reloads)
    app.mockInput.pressKey("r", { ctrl: true })
    await waitFor(
      app,
      () =>
        mounted.requests.filter((request) => new URL(request.url).searchParams.get("forceReload") === "true").length ===
        reloads + 1,
    )
  } finally {
    await mounted.destroy()
  }
})

test("paths stay usable at narrow, default and wide widths, including an empty search", async () => {
  for (const width of [64, 100, 160]) {
    await using tmp = await tmpdir()
    const mounted = await mount(tmp.path, width)
    const app = mounted.app
    try {
      await waitFor(app, () => app.captureCharFrame().includes("review"))
      app.mockInput.pressKey("p", { ctrl: true })
      await settle(app)
      expect(app.captureCharFrame()).toContain("! unavailable")
      expect(app.captureCharFrame()).toContain("! undetected")
      app.mockInput.pressKey("d", { ctrl: true })
      await settle(app)
      expect(mounted.requests.some((request) => request.method === "PUT")).toBe(false)
      await app.mockInput.typeText("no-matching-path")
      await settle(app)
      app.mockInput.pressKey("a", { ctrl: true })
      await settle(app)
      expect(app.captureCharFrame()).toContain("Add Skill path")
      app.mockInput.pressEscape()
      await settle(app)
      expect(app.captureCharFrame()).toContain("Skill paths · local")
    } finally {
      await mounted.destroy()
    }
  }
})

test("Agent name checklist saves explicitly and cancellation preserves settings at all widths", async () => {
  for (const width of [64, 100, 160]) {
    await using tmp = await tmpdir()
    const mounted = await mount(tmp.path, width)
    const app = mounted.app
    try {
      await waitFor(app, () => app.captureCharFrame().includes("review"))
      app.mockInput.pressTab()
      app.mockInput.pressTab()
      app.mockInput.pressTab()
      await settle(app)
      app.mockInput.pressEnter()
      app.mockInput.pressEnter()
      await settle(app)
      expect(app.captureCharFrame()).toContain("Agent access · review")
      expect(app.captureCharFrame()).toContain("Coordinator")
      expect(app.captureCharFrame()).toContain("Paper Reviewer")
      expect(app.captureCharFrame()).not.toContain("private-")
      if (process.env.SKILL_UI_EVIDENCE)
        await Bun.write(`${process.env.SKILL_UI_EVIDENCE}/agents-${width}.txt`, app.captureCharFrame())
      app.mockInput.pressKey(" ")
      app.mockInput.pressEscape()
      await settle(app)
      expect(mounted.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
      // Cancelling returns to the same property and selected Skill.
      expect(app.captureCharFrame()).toContain("[Agents]")
      app.mockInput.pressEnter()
      await settle(app)
      app.mockInput.pressKey(" ")
      await app.mockInput.typeText("Paper")
      await settle(app)
      app.mockInput.pressKey(" ")
      await settle(app)
      app.mockInput.pressEnter()
      await waitFor(app, () =>
        mounted.requests.some((request) => new URL(request.url).pathname.endsWith("/agent-scope")),
      )
      await settle(app)
      await waitFor(app, () => app.captureCharFrame().includes("Manage skills"))
      expect((await mounted.settings.load()).agents?.[Skill.ID.make(skillID)]).toEqual(["private-reviewer"])
      expect(mounted.requests.some((request) => new URL(request.url).searchParams.get("forceReload") === "true")).toBe(
        false,
      )
    } finally {
      await mounted.destroy()
    }
  }
})

test("reopening Skills shows renamed management labels and preserves the checked identity", async () => {
  await using tmp = await tmpdir()
  const mounted = await mount(tmp.path)
  const app = mounted.app
  try {
    await waitFor(app, () => app.captureCharFrame().includes("review"))
    const initial = await mounted.settings.load()
    await mounted.settings.updateAgentScope(Skill.ID.make(skillID), ["private-reviewer"], initial.revision)
    app.mockInput.pressEscape()
    mounted.control.open()
    await waitFor(
      app,
      () => mounted.requests.filter((r) => new URL(r.url).pathname.endsWith("/agent/catalog")).length === 2,
    )
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    await waitFor(app, () => app.captureCharFrame().includes("Paper Reviewer"))
    app.mockInput.pressEscape()
    mounted.control.reviewerName = "paper-reviewer"
    mounted.control.open()
    await waitFor(app, () => app.captureCharFrame().includes("paper-reviewer"))
    expect(app.captureCharFrame()).not.toContain("Paper Reviewer")
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("[x] paper-reviewer")
    expect(app.captureCharFrame()).not.toContain("private-reviewer")
    expect((await mounted.settings.load()).agents?.[Skill.ID.make(skillID)]).toEqual(["private-reviewer"])
    expect(mounted.requests.every((r) => r.method === "GET")).toBe(true)
    expect(mounted.requests.some((r) => new URL(r.url).pathname === "/api/agent")).toBe(false)
  } finally {
    await mounted.destroy()
  }
})

test("single-line properties keep the requested focus cycle and Source stays read-only", async () => {
  for (const width of [64, 100, 160]) {
    await using tmp = await tmpdir()
    const mounted = await mount(tmp.path, width)
    const app = mounted.app
    try {
      await waitFor(app, () => app.captureCharFrame().includes("review"))
      expect(app.captureCharFrame()).toContain("[Source]")
      expect(app.captureCharFrame()).not.toContain("Agents: all")
      app.mockInput.pressTab()
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Source]")
      expect(app.captureCharFrame()).toContain("enter items")
      app.mockInput.pressTab()
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Targets]")
      app.mockInput.pressArrow("left")
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Source]")
      app.mockInput.pressArrow("left")
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Agents]")
      app.mockInput.pressArrow("right")
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Source]")
      app.mockInput.pressEnter()
      await settle(app)
      expect(app.captureCharFrame()).toContain("enter read only")
      app.mockInput.pressArrow("right")
      await settle(app)
      expect(app.captureCharFrame()).toContain("[Source]")
      app.mockInput.pressEnter()
      await settle(app)
      expect(app.captureCharFrame()).toContain("Source · review")
      expect(app.captureCharFrame()).toContain("Imported, /opt/skills/review/SKILL.md")
      expect(mounted.requests.filter((request) => request.method !== "GET")).toHaveLength(0)
      expect(mounted.requests.some((request) => new URL(request.url).pathname.endsWith(`/skill/${skillID}`))).toBe(
        false,
      )
    } finally {
      await mounted.destroy()
    }
  }
})

test("view changes preserve search and selection in a scrollable catalog", async () => {
  await using tmp = await tmpdir()
  const mounted = await mount(tmp.path, 100, 40)
  const app = mounted.app
  try {
    await waitFor(app, () => app.captureCharFrame().includes("review-00"))
    await app.mockInput.typeText("review-2")
    await settle(app)
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    const selected = app.captureCharFrame().match(/Source · (review-\d+)/)?.[1]
    expect(selected).toBeDefined()
    app.mockInput.pressEscape()
    await settle(app)
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    await settle(app)
    expect(app.captureCharFrame()).toContain("review-2")
    expect(app.captureCharFrame()).not.toContain("review-00")
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain(`Agent access · ${selected}`)
    app.mockInput.pressEscape()
    await settle(app)
    expect(app.captureCharFrame()).toContain("[Agents]")
    expect(app.captureCharFrame()).not.toContain("review-00")
    app.mockInput.pressTab()
    await app.mockInput.typeText("2")
    await settle(app)
    expect(app.captureCharFrame()).toContain("enter edit")
    expect(app.captureCharFrame()).toContain("review-22")
    expect(mounted.requests.filter((request) => request.method !== "GET")).toHaveLength(0)
  } finally {
    await mounted.destroy()
  }
})

async function mount(root: string, width = 100, count = 1) {
  const state = path.join(root, "state")
  const configDirectory = path.join(root, "config")
  await mkdir(state, { recursive: true })
  await mkdir(configDirectory)
  await Bun.write(path.join(state, "kv.json"), "{}")
  const broken = path.join(root, "broken-file")
  await Bun.write(broken, "keep")
  await Bun.write(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ skills: { paths: [broken] } }))
  const settings = SkillSettings.make({ directory: configDirectory, home: root })
  const requests: Request[] = []
  const control = { open: () => {}, reviewerName: "Paper Reviewer" }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input, init)
    requests.push(request)
    const url = new URL(request.url)
    if (url.pathname.endsWith("/fs/list"))
      return json({ data: [{ name: "completed", path: "/completed", type: "directory" }] })
    if (url.pathname.endsWith("/skill/settings/discovery"))
      return json(await settings.updateDiscovery(Skill.DiscoveryUpdate.make(await request.json())))
    if (url.pathname.endsWith("/agent/catalog"))
      return json({
        data: [
          { id: "private-primary", name: "Coordinator", mode: "primary", hidden: false },
          { id: "private-reviewer", name: control.reviewerName, mode: "subagent", hidden: false },
        ],
      })
    if (url.pathname.endsWith("/agent-scope")) {
      const input = await request.json()
      return json(await settings.updateAgentScope(Skill.ID.make(skillID), input.scope, input.expectedRevision))
    }
    if (url.pathname.endsWith("/target-scope")) {
      const input = await request.json()
      return json(await settings.updateTargetScope(Skill.ID.make(skillID), input.scope, input.expectedRevision))
    }
    if (url.pathname.endsWith("/skill/settings")) return json(await settings.load())
    if (url.pathname.endsWith("/skill/catalog"))
      return json({
        data: {
          revision: "catalog",
          digest: "catalog",
          diagnostics: [],
          skills: Array.from({ length: count }, (_, index) => ({
            id: count === 1 ? skillID : `skl_${index.toString(16).padStart(64, "0")}`,
            name: count === 1 ? "review" : `review-${String(index).padStart(2, "0")}`,
            sourceLabel: "Imported",
            digest: "digest",
          })),
          locations: { [skillID]: "/opt/skills/review/SKILL.md" },
        },
      })
    if (url.pathname.endsWith("/target")) return json({ revision: "targets", targets: [] })
    throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
  }) as typeof globalThis.fetch
  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const unregister = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(unregister)
    function OpenDialog() {
      const manager = useSkillManager()
      onMount(() => {
        control.open = () => manager.open()
        manager.open()
      })
      return null
    }
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ClipboardProvider value={{ write: async () => undefined }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <RemoteStatusProvider>
                      <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                        <DialogProvider>
                          <OpenDialog />
                        </DialogProvider>
                        <Toast />
                      </SDKProvider>
                    </RemoteStatusProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const rendered = await testRenderExclusive(() => <Harness />, {
    width,
    height: 32,
    kittyKeyboard: true,
    useThread: false,
  })
  return { ...rendered, requests, settings, broken, control }
}

async function settle(app: Awaited<ReturnType<typeof testRenderExclusive>>["app"]) {
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
}

async function waitFor(app: Awaited<ReturnType<typeof testRenderExclusive>>["app"], predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(10)
    await app.renderOnce()
    if (predicate()) return
  }
  throw new Error(`UI did not settle:\n${app.captureCharFrame()}`)
}

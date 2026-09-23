/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { DialogSessionPolicy } from "../../src/component/dialog-session-policy"
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

const view = {
  status: "pending" as const,
  revision: 2,
  legacyDigest: "a".repeat(64),
  location: { target: { type: "local" as const }, directory: "/workspace" },
  locationRevision: 3,
  baseline: [
    { action: "read", resource: "*.env", effect: "deny" as const },
    { action: "external_directory", resource: "/historical/*", effect: "allow" as const },
  ],
  rules: [{ action: "read", resource: "*.env", effect: "deny" as const }],
}

test.serial("Session policy dialog toggles choices, applies exact snapshots, and closes without mutation", async () => {
  await using tmp = await tmpdir()
  const mounted = await mount(tmp.path)
  try {
    await settle(mounted.app)
    expect(mounted.app.captureCharFrame()).toContain("pending")
    expect(mounted.app.captureCharFrame()).toContain("○ d")
    mounted.app.mockInput.pressArrow("down")
    mounted.app.mockInput.pressEnter()
    await mounted.app.renderOnce()
    expect(mounted.app.captureCharFrame()).toContain("● r")

    mounted.app.mockInput.pressArrow("down")
    mounted.app.mockInput.pressEnter()
    await mounted.app.waitFor(() => mounted.requests.filter((request) => request.method === "POST").length === 1)
    const body = await mounted.requests
      .find((request) => request.method === "POST")!
      .clone()
      .json()
    expect(body).toMatchObject({
      expectedRevision: 2,
      legacyDigest: view.legacyDigest,
      locationRevision: 3,
      location: view.location,
      accepted: [true],
    })
    expect(body.requestID).toBeString()
  } finally {
    await mounted.destroy()
  }

  const cancelled = await mount(tmp.path)
  try {
    await settle(cancelled.app)
    expect(cancelled.app.captureCharFrame()).toContain("○ d")
    cancelled.app.mockInput.pressArrow("down")
    cancelled.app.mockInput.pressArrow("down")
    cancelled.app.mockInput.pressArrow("down")
    cancelled.app.mockInput.pressArrow("down")
    cancelled.app.mockInput.pressEnter()
    await cancelled.app.waitFor(() => cancelled.closed === 1)
    await cancelled.app.renderOnce()
    expect(cancelled.requests.some((request) => request.method === "POST")).toBe(false)
    expect(cancelled.closed).toBe(1)
    expect(cancelled.app.captureCharFrame()).not.toContain("Session permissions")
  } finally {
    await cancelled.destroy()
  }
})

test.serial("Session policy dialog preserves choices and offers reload after a conflict", async () => {
  await using tmp = await tmpdir()
  const mounted = await mount(tmp.path, true)
  try {
    await settle(mounted.app)
    expect(mounted.app.captureCharFrame()).toContain("○ d")
    mounted.app.mockInput.pressArrow("down")
    mounted.app.mockInput.pressEnter()
    await mounted.app.renderOnce()
    mounted.app.mockInput.pressArrow("down")
    mounted.app.mockInput.pressEnter()
    await mounted.app.waitFor(() => mounted.requests.filter((request) => request.method === "POST").length === 1)
    await settle(mounted.app)
    expect(mounted.app.captureCharFrame()).toContain("Policy revision changed")
    expect(mounted.app.captureCharFrame()).toContain("● r")
    expect(mounted.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  } finally {
    await mounted.destroy()
  }
})

async function mount(root: string, conflict = false) {
  const state = path.join(root, `state-${crypto.randomUUID()}`)
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const requests: Request[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input, init)
    requests.push(request)
    if (request.method === "GET") return json({ data: view })
    if (conflict)
      return json(
        { name: "ConflictError", data: { message: "Policy revision changed", resource: "session.policy" } },
        { status: 409 },
      )
    return json({
      data: {
        version: 1,
        sessionID: "session-test",
        requestID: "saved",
        deviceID: "device",
        previousRevision: 2,
        revision: 3,
        legacyDigest: view.legacyDigest,
        locationRevision: 3,
        directory: "/workspace",
        baseline: view.baseline,
        accepted: [true],
      },
    })
  }) as typeof globalThis.fetch
  let closed = 0

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const unregister = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(unregister)
    function Modal() {
      onCleanup(() => {
        closed += 1
      })
      return <DialogSessionPolicy sessionID="session-test" />
    }
    function OpenDialog() {
      const dialog = useDialog()
      onMount(() => dialog.replace(() => <Modal />))
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
    width: 80,
    height: 24,
    kittyKeyboard: true,
    useThread: false,
  })
  return {
    requests,
    get closed() {
      return closed
    },
    app: rendered.app,
    destroy: rendered.destroy,
  }
}

async function settle(app: Awaited<ReturnType<typeof testRenderExclusive>>["app"]) {
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
}

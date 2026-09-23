/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onCleanup, type ParentProps } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider, useKV } from "../../../src/context/kv"
import { LocationProvider } from "../../../src/context/location"
import { RemoteStatusProvider } from "../../../src/context/remote-status"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncContext, type RoutedPermissionRequest } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource, json } from "../../fixture/tui-sdk"
import { testRenderExclusive } from "../../fixture/tui-renderer"

const targetID = "target-test"
const request: RoutedPermissionRequest = {
  id: "permission-test",
  sessionID: "session-test",
  permission: "external_directory",
  patterns: ["/outside/*"],
  always: ["/outside/*"],
  metadata: { filepath: "/outside/file", parentDir: "/outside" },
}

function Ready(props: ParentProps<{ onReady: () => void }>) {
  const kv = useKV()
  createEffect(() => {
    if (kv.ready) props.onReady()
  })
  return <>{props.children}</>
}

async function mountPermission(input: { root: string; fail?: boolean; local?: boolean; v2?: boolean }) {
  await mkdir(path.join(input.root, "state"), { recursive: true })
  await Bun.write(path.join(input.root, "state", "kv.json"), "{}")
  const calls: Request[] = []
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const fetch = (async (value: RequestInfo | URL, init?: RequestInit) => {
    const current = value instanceof Request && !init ? value : new Request(value, init)
    calls.push(current)
    if (input.fail)
      return json(
        { name: "PermissionNotFoundError", data: { message: "Permission request not found" } },
        { status: 404 },
      )
    return json(true)
  }) as typeof globalThis.fetch

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const unregister = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(unregister)
    const location = input.local
      ? { directory: "/Users/test/project", workspaceID: "workspace-test", target: { type: "local" as const } }
      : { directory: "/home/test/project", target: { type: "rexd" as const, targetID } }
    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state: path.join(input.root, "state") }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <Ready onReady={resolveReady}>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <RemoteStatusProvider>
                      <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                        <SyncContext.Provider
                          value={
                            {
                              data: { session: [], part: {} },
                              session: { get: () => ({ id: request.sessionID, ...location }) },
                            } as never
                          }
                        >
                          <LocationProvider location={location}>
                            <PermissionPrompt
                              request={{ ...request, ...(input.v2 ? { api: "v2" as const } : {}) }}
                              location={location}
                            />
                          </LocationProvider>
                        </SyncContext.Provider>
                        <Toast />
                      </SDKProvider>
                    </RemoteStatusProvider>
                  </ToastProvider>
                </ThemeProvider>
              </Ready>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const rendered = await testRenderExclusive(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  await ready
  await rendered.app.renderOnce()
  await Bun.sleep(10)
  return { app: rendered.app, calls, destroy: rendered.destroy }
}

test("legacy Rexd permission replies route through the target", async () => {
  await using tmp = await tmpdir()
  const permission = await mountPermission({ root: tmp.path })
  try {
    permission.app.mockInput.pressEnter()
    await permission.app.waitFor(() => permission.calls.length === 1)
    expect(new URL(permission.calls[0]!.url).pathname).toBe("/permission/permission-test/reply")
    expect(permission.calls[0]!.headers.get("x-opencode-target")).toBe(targetID)
    expect(new URL(permission.calls[0]!.url).searchParams.has("directory")).toBe(false)
  } finally {
    await permission.destroy()
  }
})

test("local legacy permission replies retain directory and workspace", async () => {
  await using tmp = await tmpdir()
  const permission = await mountPermission({ root: tmp.path, local: true })
  try {
    permission.app.mockInput.pressEnter()
    await permission.app.waitFor(() => permission.calls.length === 1)
    const url = new URL(permission.calls[0]!.url)
    expect(url.searchParams.get("directory")).toBe("/Users/test/project")
    expect(url.searchParams.get("workspace")).toBe("workspace-test")
  } finally {
    await permission.destroy()
  }
})

test("canonical permission replies use the Session-scoped API", async () => {
  await using tmp = await tmpdir()
  const permission = await mountPermission({ root: tmp.path, v2: true })
  try {
    permission.app.mockInput.pressEnter()
    await permission.app.waitFor(() => permission.calls.length === 1)
    expect(new URL(permission.calls[0]!.url).pathname).toBe(
      "/api/session/session-test/permission/permission-test/reply",
    )
    expect(permission.calls[0]!.headers.has("x-opencode-target")).toBe(false)
  } finally {
    await permission.destroy()
  }
})

test("permission reply failures are visible", async () => {
  await using tmp = await tmpdir()
  const permission = await mountPermission({ root: tmp.path, fail: true, v2: true })
  try {
    permission.app.mockInput.pressEnter()
    await permission.app.waitFor(() => permission.calls.length === 1)
    await permission.app.waitFor(() => permission.app.captureCharFrame().includes("Permission request not found"))
  } finally {
    await permission.destroy()
  }
})

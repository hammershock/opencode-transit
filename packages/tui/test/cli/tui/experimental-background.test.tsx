/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { DialogExperimentalCommands } from "../../../src/component/dialog-experimental-commands"
import { TuiConfigProvider } from "../../../src/config"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { RemoteStatusProvider } from "../../../src/context/remote-status"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../../src/keymap"
import { DialogProvider } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { eventSource, json } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test.each([60, 90, 120])(
  "background experiment loads, saves and retains state on failure at width %s",
  async (width) => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    let keymap!: OpenTuiKeymap
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const patches: unknown[] = []
    let fail = false
    let saved: boolean | undefined
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname !== "/global/config") return json({})
      if (request.method === "PATCH") {
        const body = (await request.json()) as { experimental: { background_subagents: boolean } }
        patches.push(body)
        if (fail) return json({ name: "UnknownError", data: { message: "write failed" } }, { status: 500 })
        saved = body.experimental.background_subagents
        return json(body)
      }
      await ready
      return json({ experimental: { background_subagents: saved } })
    }) as typeof globalThis.fetch

    function Harness() {
      const renderer = useRenderer()
      keymap = createDefaultOpenTuiKeymap(renderer)
      const config = createTuiResolvedConfig()
      onCleanup(registerOpencodeKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <ClipboardProvider value={{}}>
            <OpencodeKeymapProvider keymap={keymap}>
              <TuiConfigProvider config={config}>
                <KVProvider>
                  <ThemeProvider mode="dark">
                    <ToastProvider>
                      <Toast />
                      <RemoteStatusProvider>
                        <SDKProvider url="http://test" directory={tmp.path} fetch={fetch} events={eventSource()}>
                          <DialogProvider>
                            <DialogExperimentalCommands current="fork.subagent.background" />
                          </DialogProvider>
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

    const app = await testRender(() => <Harness />, { width, height: 30, kittyKeyboard: true })
    async function frame(text: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        await app.renderOnce()
        if (app.captureCharFrame().includes(text)) return app.captureCharFrame()
        await Bun.sleep(10)
      }
      throw new Error(`Missing ${text}:\n${app.captureCharFrame()}`)
    }
    try {
      await frame("checking")
      await Bun.sleep(10)
      keymap.dispatchCommand("dialog.experimental.toggle")
      expect(patches).toHaveLength(0)
      release()
      await frame("env default")
      keymap.dispatchCommand("dialog.experimental.toggle")
      await frame("saved on")
      expect(patches).toEqual([{ experimental: { background_subagents: true } }])
      fail = true
      keymap.dispatchCommand("dialog.experimental.toggle")
      await frame("write failed")
      expect(saved).toBe(true)
      expect(app.captureCharFrame()).toContain("saved on")
      fail = false
      keymap.dispatchCommand("dialog.experimental.toggle")
      for (let attempt = 0; attempt < 100 && saved !== false; attempt++) await Bun.sleep(10)
      expect(saved).toBe(false)
      const output = await frame("saved off")
      expect(output).toContain("Background subagents")
    } finally {
      release()
      app.renderer.destroy()
    }
  },
)

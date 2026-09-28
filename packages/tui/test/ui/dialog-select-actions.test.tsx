/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("target add shortcut works without a selection while delete remains guarded", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const added: boolean[] = []
  const deleted: number[] = []
  let keymap!: OpenTuiKeymap
  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ClipboardProvider value={{}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <box width="100%" height="100%">
                        <DialogSelect<number>
                          title="Manage targets"
                          options={[]}
                          actions={[
                            {
                              command: "dialog.target.add",
                              title: "add",
                              requiresSelection: false,
                              onTrigger: () => {
                                added.push(true)
                              },
                            },
                            {
                              command: "dialog.target.delete",
                              title: "delete",
                              onTrigger: (option) => {
                                deleted.push(option.value)
                              },
                            },
                          ]}
                        />
                      </box>
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 70, height: 24, kittyKeyboard: true })
  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    app.mockInput.pressKey("a", { ctrl: true })
    await app.renderOnce()
    expect(added).toHaveLength(1)
    keymap.dispatchCommand("dialog.target.delete")
    expect(deleted).toEqual([])
    app.mockInput.pressTab()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(added).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})

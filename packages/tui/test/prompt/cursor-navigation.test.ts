import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

test("production prompt preserves Unicode navigation and history boundaries", async () => {
  const setup = await createTestRenderer({ width: 50, height: 25, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/agent")
      return json([{ name: "build", mode: "primary", hidden: false, permission: [], options: {} }])
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  try {
    const { run } = await import("../../src/app")
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
    const editor = setup.renderer.currentFocusedEditor
    expect(editor).toBeInstanceOf(TextareaRenderable)
    if (!(editor instanceof TextareaRenderable)) throw new Error("No editor")
    editor.setText("abcdefg\n中文测试\ntail")
    setup.mockInput.pressKey("HOME")
    for (let index = 0; index < 7; index++) setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("down")
    expect(editor.logicalCursor).toMatchObject({ row: 1, col: 7 })
    setup.mockInput.pressArrow("right")
    expect(editor.logicalCursor).toMatchObject({ row: 1, col: 8 })
    setup.mockInput.pressKey("X")
    expect(editor.plainText).toBe("abcdefg\n中文测试X\ntail")

    editor.setText("中文测试")
    setup.mockInput.pressKey("HOME")
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("right")
    expect(editor.cursorOffset).toBe(4)
    setup.mockInput.pressArrow("down")
    expect(editor.cursorOffset).toBe(8)
    setup.mockInput.pressArrow("down")
    expect(editor.cursorOffset).toBe(8)
    expect(editor.plainText).toBe("中文测试")

    // Rapid traversal also covers soft wraps, explicit newlines, and combining marks.
    for (const text of ["abc\n中文测试\nabc", "abc 中文👩‍💻é ".repeat(10)]) {
      editor.setText("")
      const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
      for (const part of parts) editor.insertText(part.segment)
      setup.mockInput.pressKey("HOME")
      await setup.renderOnce()
      for (const part of parts) {
        const before = editor.cursorOffset
        setup.mockInput.pressArrow("right")
        expect(editor.cursorOffset, part.segment).toBeGreaterThan(before)
      }
      for (const part of parts) {
        const before = editor.cursorOffset
        setup.mockInput.pressArrow("left")
        expect(editor.cursorOffset, part.segment).toBeLessThan(before)
      }
      expect(editor.cursorOffset).toBe(0)
      expect(editor.plainText).toBe(text)
    }
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 15_000)

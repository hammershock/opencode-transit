/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { Dialog } from "../../src/ui/dialog"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const width of [40, 80, 120]) {
  test(`dialog preserves and dims wide glyphs at ${width} columns`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const [open, setOpen] = createSignal(false)
    const text = "English 中文测试 日本語 한글 e\u0301 🙂"
    const app = await testRender(
      () => (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width="100%" height="100%" backgroundColor="#808080">
                  <text fg="#ffffff">{text}</text>
                  <Show when={open()}>
                    <Dialog onClose={() => setOpen(false)}>
                      <text fg="#ffffff">Panel 弹窗</text>
                    </Dialog>
                  </Show>
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 24 },
    )
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        await app.renderOnce()
        if (app.captureCharFrame().includes(text)) break
        await Bun.sleep(10)
      }
      expect(app.captureCharFrame()).toContain(text)
      const original = app.captureSpans().lines[0].spans[0]
      for (const cycle of [0, 1]) {
        setOpen(true)
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain(text)
        expect(app.captureCharFrame()).toContain("Panel 弹窗")
        const dimmed = app.captureSpans().lines[0].spans[0]
        expect(dimmed.fg.r).toBeGreaterThan(0)
        expect(dimmed.fg.r).toBeLessThan(original.fg.r)
        expect(dimmed.bg.r).toBeLessThan(original.bg.r)
        const panel = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("Panel"))!
        expect(panel.fg.r).toBeCloseTo(original.fg.r, 2)
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain(text)
        expect(app.captureSpans().lines[0].spans[0].fg.r).toBeCloseTo(dimmed.fg.r, 2)
        if (cycle === 0) {
          await app.mockMouse.click(1, 1)
        }
        if (cycle === 1) setOpen(false)
        await app.renderOnce()
        expect(open()).toBe(false)
        expect(app.captureCharFrame()).not.toContain("Panel 弹窗")
        expect(app.captureCharFrame()).toContain(text)
        expect(app.captureSpans().lines[0].spans[0].fg.r).toBeCloseTo(original.fg.r, 2)
      }
    } finally {
      app.renderer.destroy()
    }
  })
}

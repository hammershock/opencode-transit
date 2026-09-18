import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerOpencodeKeymap } from "../../src/keymap"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function setupEditor(text: string, width = 30) {
  const setup = await createTestRenderer({ width: 40, height: 12, useThread: false })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const dispose = registerOpencodeKeymap(keymap, setup.renderer, createTuiResolvedConfig({}))
  const editor = new TextareaRenderable(setup.renderer, { id: "cursor-test", width, height: 6 })
  setup.renderer.root.add(editor)
  editor.setText(text)
  editor.focus()
  await setup.renderOnce()
  return { ...setup, editor, dispose, keymap }
}

for (const direction of ["left", "right"] as const) {
  for (const text of ["中文测试", "中文测👩‍💻", "中文测\t"]) {
    test(`${direction} after Down enters the last wide grapheme: ${JSON.stringify(text)}`, async () => {
      const setup = await setupEditor(`abcdefg\n${text}\ntail`)
      try {
        setup.mockInput.pressKey("HOME")
        for (let index = 0; index < 7; index++) setup.mockInput.pressArrow("right")
        setup.mockInput.pressArrow("down")
        expect(setup.editor.logicalCursor).toMatchObject({ row: 1, col: 7 })
        setup.mockInput.pressArrow(direction)
        expect(setup.editor.logicalCursor).toMatchObject({ row: 1, col: direction === "right" ? 8 : 6 })
        setup.mockInput.pressKey("X")
        expect(setup.editor.plainText).toBe(
          `abcdefg\n中文测${direction === "right" ? text.slice(3) + "X" : "X" + text.slice(3)}\ntail`,
        )
      } finally {
        setup.dispose()
        setup.renderer.destroy()
      }
    })
  }
}

test("Left after Up moves to the containing character instead of skipping it", async () => {
  const setup = await setupEditor("中文测试\nabc")
  try {
    setup.mockInput.pressKey("END")
    setup.mockInput.pressArrow("up")
    expect(setup.editor.logicalCursor).toMatchObject({ row: 0, col: 3 })
    setup.mockInput.pressArrow("left")
    expect(setup.editor.logicalCursor).toMatchObject({ row: 0, col: 2 })
    setup.mockInput.pressArrow("right", { shift: true })
    expect(setup.editor.getSelectedText()).toBe("文")
    setup.mockInput.pressArrow("right")
    expect(setup.editor.logicalCursor.col).toBe(4)
    expect(setup.editor.hasSelection()).toBe(false)
  } finally {
    setup.dispose()
    setup.renderer.destroy()
  }
})

test("wrapped rows and Emacs bindings preserve wide-character boundaries", async () => {
  const setup = await setupEditor("abcdefg 中文测试", 8)
  try {
    setup.mockInput.pressKey("HOME")
    for (let index = 0; index < 7; index++) setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("down")
    expect(setup.editor.logicalCursor.col).toBe(15)
    setup.mockInput.pressKey("f", { ctrl: true })
    expect(setup.editor.cursorOffset).toBe(16)
    setup.mockInput.pressKey("b", { ctrl: true })
    expect(setup.editor.cursorOffset).toBe(14)
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("right")
    expect(setup.editor.cursorOffset).toBe(16)
  } finally {
    setup.dispose()
    setup.renderer.destroy()
  }
})

test("Shift+Right from a wide cell selects a whole grapheme and retains its anchor", async () => {
  const setup = await setupEditor("abcdefg\n中文测试尾")
  try {
    setup.mockInput.pressKey("HOME")
    for (let index = 0; index < 7; index++) setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("right", { shift: true })
    expect(setup.editor.getSelectedText()).toBe("试")
    setup.mockInput.pressArrow("right", { shift: true })
    expect(setup.editor.getSelectedText()).toBe("试尾")
    expect(setup.editor.plainText).toBe("abcdefg\n中文测试尾")
  } finally {
    setup.dispose()
    setup.renderer.destroy()
  }
})

test("single-line inputs retain native bindings and textarea overrides dispose", async () => {
  const setup = await setupEditor("abc")
  try {
    const input = new InputRenderable(setup.renderer, { id: "single-line", width: 20, value: "abc" })
    setup.renderer.root.add(input)
    input.focus()
    setup.mockInput.pressKey("HOME")
    setup.mockInput.pressArrow("right")
    expect(input.cursorOffset).toBe(1)
    setup.dispose()
    setup.editor.focus()
    setup.editor.gotoBufferHome()
    setup.mockInput.pressArrow("right")
    expect(setup.editor.cursorOffset).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

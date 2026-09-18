import type { TextareaRenderable } from "@opentui/core"

export function movePromptCursor(editor: TextareaRenderable, direction: "left" | "right", select = false) {
  const cursor = editor.logicalCursor
  // OpenTUI 0.4.5 can leave vertical/mouse cursors inside a wide grapheme.
  // Horizontal movement then skips characters or stalls at the last one.
  // Native ranges expand to grapheme boundaries, including tabs and emoji.
  if ((select || !editor.hasSelection()) && cursor.col > 0 && cursor.col < editor.editBuffer.getEOL().col) {
    let col = cursor.col
    while (
      col > 0 &&
      col < editor.editBuffer.getEOL().col &&
      editor.getTextRangeByCoords(cursor.row, 0, cursor.row, col) ===
        editor.getTextRangeByCoords(cursor.row, 0, cursor.row, col + 1)
    ) {
      col += direction === "right" ? -1 : 1
    }
    if (col !== cursor.col) editor.setCursor(cursor.row, col)
  }
  return direction === "right" ? editor.moveCursorRight({ select }) : editor.moveCursorLeft({ select })
}

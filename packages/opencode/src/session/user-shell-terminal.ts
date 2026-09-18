import type { Terminal } from "@xterm/headless"

export * as UserShellTerminal from "./user-shell-terminal"

export interface Renderer {
  readonly write: (chunk: string) => Promise<string>
  readonly snapshot: () => string
  readonly dispose: () => void
}

export async function create(): Promise<Renderer> {
  const { Terminal } = await import("@xterm/headless")
  const terminal = new Terminal({
    cols: 120,
    rows: 24,
    scrollback: 2000,
    allowProposedApi: true,
    convertEol: true,
  })
  return {
    write: (chunk) =>
      new Promise((resolve) => {
        terminal.write(chunk, () => resolve(snapshot(terminal)))
      }),
    snapshot: () => snapshot(terminal),
    dispose: () => terminal.dispose(),
  }
}

function snapshot(terminal: Terminal) {
  return Array.from({ length: terminal.buffer.active.length }, (_, index) =>
    terminal.buffer.active.getLine(index)?.translateToString(true),
  )
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trimEnd()
}

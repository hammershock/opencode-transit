import { describe, expect, test } from "bun:test"
import { UserShellTerminal } from "@/session/user-shell-terminal"

describe("user shell terminal", () => {
  test("snapshots the rendered terminal instead of control sequences", async () => {
    const terminal = await UserShellTerminal.create()
    await terminal.write("download 10%")
    await terminal.write("\rdownload 50%")
    await terminal.write("\r\x1b[32mdownload 100%\x1b[0m\n")

    expect(terminal.snapshot()).toBe("download 100%")
    terminal.dispose()
  })

  test("snapshots the current display when execution is interrupted", async () => {
    const terminal = await UserShellTerminal.create()
    await terminal.write("step 1\rstep 2")

    expect(terminal.snapshot()).toBe("step 2")
    terminal.dispose()
  })
})

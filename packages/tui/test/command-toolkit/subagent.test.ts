import { describe, expect, test } from "bun:test"
import { createCommandHost } from "../../src/command-toolkit/host"
import { subagentCommand, type SubagentCommandContext } from "../../src/command-toolkit/subagent"

describe("subagent command", () => {
  test("opens the manager from slash and palette invocations", async () => {
    const opened: string[] = []
    const host = createCommandHost<SubagentCommandContext>({
      register: (registry) => registry.register(subagentCommand),
      context: (source) => ({
        source,
        client: "tui",
        abortSignal: new AbortController().signal,
        confirm: async () => false,
        openSubagentManager: () => opened.push(source),
      }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.registrations()).toEqual([
      expect.objectContaining({ name: "fork.subagent.manage", slashName: "subagent", title: "Manage subagents" }),
    ])
    expect(await host("/subagent")).toMatchObject({ status: "handled", identity: "fork.subagent.manage" })
    const registration = host.registrations()[0]
    if (!registration) throw new Error("Expected palette registration")
    await registration.run()
    expect(opened).toEqual(["slash", "palette"])
  })

  test("rejects arguments before opening the manager", () => {
    expect(
      subagentCommand.parse({
        source: "/subagent unexpected",
        value: "unexpected",
        range: { start: 10, end: 20 },
      }),
    ).toMatchObject({ status: "invalid", code: "unexpected_arguments" })
  })
})

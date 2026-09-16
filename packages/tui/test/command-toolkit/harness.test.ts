import { describe, expect, test } from "bun:test"
import { createCommandHost } from "../../src/command-toolkit/host"
import { harnessCommand, type HarnessCommandContext } from "../../src/command-toolkit/harness"

describe("harness command", () => {
  test("routes the menu and both shortcuts through one manager", async () => {
    const opened: string[] = []
    const host = createCommandHost<HarnessCommandContext>({
      register: (registry) => registry.register(harnessCommand),
      context: (source) => ({
        source,
        client: "tui",
        abortSignal: new AbortController().signal,
        confirm: async () => false,
        openHarnessManager: (view) => opened.push(`${source}:${view}`),
      }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.registrations()).toEqual([
      expect.objectContaining({ name: "fork.harness.manage", slashName: "harness", title: "Manage harness" }),
    ])
    expect(await host("/harness")).toMatchObject({ status: "handled" })
    expect(await host("/harness instructions")).toMatchObject({ status: "handled" })
    expect(await host("/harness skills")).toMatchObject({ status: "handled" })
    await host.registrations()[0]!.run()
    expect(opened).toEqual(["slash:menu", "slash:instructions", "slash:skills", "palette:menu"])
  })

  test("rejects unknown subcommands", () => {
    expect(
      harnessCommand.parse({
        source: "/harness unknown",
        value: "unknown",
        range: { start: 9, end: 16 },
      }),
    ).toMatchObject({ status: "invalid", code: "unexpected_arguments" })
  })
})

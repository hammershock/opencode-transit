import { expect, test } from "bun:test"
import { createCommandHost } from "../../src/command-toolkit/host"
import { recentCommand, type RecentCommandContext } from "../../src/command-toolkit/recent"

test("recent opens the same workflow from slash and palette and rejects arguments", async () => {
  const opened: string[] = []
  const host = createCommandHost<RecentCommandContext>({
    register: (registry) => registry.register(recentCommand),
    context: (source) => ({
      source,
      client: "tui",
      abortSignal: new AbortController().signal,
      confirm: async () => false,
      openRecentLocations: () => {
        opened.push(source)
      },
    }),
    upstream: () => undefined,
    invalid: () => undefined,
    outcome: () => undefined,
  })
  expect(await host("/recent")).toMatchObject({ status: "handled", identity: "fork.location.recent" })
  await host.registrations()[0].run()
  expect(opened).toEqual(["slash", "palette"])
  expect(recentCommand.parse({ source: "/recent extra", value: "extra", range: { start: 8, end: 13 } })).toMatchObject({
    status: "invalid",
  })
})

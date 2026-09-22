import { defineCommand, type InvocationContext } from "@opencode-ai/command-kit"

export type RecentCommandContext = InvocationContext & {
  openRecentLocations: () => void
}

// Registered by Home only, so palette, completion and direct submit share scope.
export const recentCommand = defineCommand<void, RecentCommandContext>({
  id: "fork.location.recent",
  path: ["recent"],
  title: "Recent locations",
  description: "Choose a recently used target and directory for a new session",
  category: "Location",
  provenance: { type: "core", feature: "recent-locations" },
  capabilities: [],
  parse: (raw) =>
    raw.value.trim()
      ? { status: "invalid", code: "unexpected_arguments", message: "Usage: /recent", range: raw.range }
      : { status: "parsed", input: undefined },
  execute: async (ctx) => {
    ctx.openRecentLocations()
    return { status: "completed" }
  },
})

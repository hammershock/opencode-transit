import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SubagentCommandContext = InvocationContext & {
  openSubagentManager: () => void
}

const empty = (raw: RawArguments) =>
  raw.value.trim()
    ? ({
        status: "invalid",
        code: "unexpected_arguments",
        message: "Usage: /subagent",
        range: raw.range,
      } as const)
    : ({ status: "parsed", input: undefined } as const)

export const subagentCommand = defineCommand<void, SubagentCommandContext>({
  id: "fork.subagent.manage",
  path: ["subagent"],
  title: "Manage subagents",
  description: "Manage definitions and access for the current Agent",
  category: "Agents",
  provenance: { type: "core", feature: "subagent-manager" },
  capabilities: ["subagent.catalog.read", "subagent.catalog.write"],
  parse: empty,
  execute: async (ctx) => {
    ctx.openSubagentManager()
    return { status: "completed" }
  },
})

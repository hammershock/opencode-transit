import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type HarnessView = "menu" | "instructions" | "skills"

export type HarnessCommandContext = InvocationContext & {
  openHarnessManager: (view: HarnessView) => void
}

const parse = (raw: RawArguments) => {
  const value = raw.value.trim()
  if (!value) return { status: "parsed", input: "menu" as const } as const
  if (value === "instructions" || value === "skills") return { status: "parsed", input: value } as const
  return {
    status: "invalid",
    code: "unexpected_arguments",
    message: "Usage: /harness [instructions|skills]",
    range: raw.range,
  } as const
}

export const harnessCommand = defineCommand<HarnessView, HarnessCommandContext>({
  id: "fork.harness.manage",
  path: ["harness"],
  title: "Manage harness",
  description: "Manage controller instructions and Skills",
  category: "Settings",
  provenance: { type: "core", feature: "harness-settings" },
  capabilities: ["harness.instructions.read", "harness.instructions.write", "skill.registry.read"],
  parse,
  execute: async (ctx, view) => {
    ctx.openHarnessManager(view)
    return { status: "completed" }
  },
})

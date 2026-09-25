import type { AgentV2 } from "@opencode-ai/core/agent"

export function render(agents: readonly AgentV2.Info[]) {
  const entries = agents.filter((agent) => agent.mode !== "primary").toSorted((a, b) => a.id.localeCompare(b.id))
  if (entries.length === 0) return undefined
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const lines = entries.map(
    (agent) =>
      `<subagent id="${escape(agent.id.slice(0, 64))}">${escape((agent.description ?? "Call only when the user explicitly selects this subagent.").slice(0, 240))}</subagent>`,
  )
  const opening = "<available-subagents>"
  const guidance = "These are catalog candidates; agent_spawn validates current access before launch."
  const closing = "</available-subagents>"
  const selected = lines.reduce<string[]>(
    (current, line) =>
      Buffer.byteLength([opening, guidance, ...current, line, "<truncated />", closing].join("\n")) <= 8192
        ? [...current, line]
        : current,
    [],
  )
  return [opening, guidance, ...selected, ...(selected.length < lines.length ? ["<truncated />"] : []), closing].join(
    "\n",
  )
}

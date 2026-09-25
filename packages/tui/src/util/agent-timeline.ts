export * as AgentTimeline from "./agent-timeline"

type Message = { id: string; time: { created: number }; role?: string }
type Activity = { id: string; seq: number; waitCallID: string | null }
type Part = { id: string }

/** Stable keys keep call rows mounted while replay catches up or state updates arrive. */
export function order(input: {
  messages: readonly Message[]
  anchors: ReadonlyMap<string, number>
  activities: readonly Activity[]
  parts?: ReadonlyMap<string, readonly Part[]>
  readyAt?: number
}) {
  const visible = input.messages.filter(
    (message) => input.readyAt === undefined || input.anchors.has(message.id) || message.time.created < input.readyAt,
  )
  const first = Math.min(
    ...visible.flatMap((message) => {
      const seq = input.anchors.get(message.id)
      return seq === undefined ? [] : [seq]
    }),
  )
  return [
    ...visible.flatMap((message, index) => {
      const base = input.anchors.get(message.id) ?? Number.NEGATIVE_INFINITY
      const parts = message.role === "assistant" ? (input.parts?.get(message.id) ?? []) : []
      if (message.role !== "assistant") return [{ key: `message:${message.id}`, seq: base, fallback: index * 1_000 }]
      const rows = parts.map((part, partIndex) => ({
        key: `part:${message.id}:${part.id}`,
        seq: input.anchors.get(part.id) ?? (base === Number.NEGATIVE_INFINITY ? base : base + (partIndex + 1) / 1_000),
        fallback: index * 1_000 + partIndex,
      }))
      return [
        ...rows,
        {
          key: `footer:${message.id}`,
          seq:
            input.anchors.get(`footer:${message.id}`) ??
            (rows.length ? Math.max(...rows.map((row) => row.seq)) + 0.5 : base),
          fallback: index * 1_000 + parts.length,
        },
      ]
    }),
    ...input.activities
      .filter((item) => item.waitCallID === null && (first === Infinity || item.seq >= first))
      .map((item) => ({ key: `activity:${item.id}`, seq: item.seq, fallback: 0 })),
  ]
    .toSorted((a, b) => a.seq - b.seq || a.fallback - b.fallback || a.key.localeCompare(b.key))
    .map((item) => item.key)
}

export function label(kind: "reply" | "notice" | "completed" | "failed" | "interrupted", actor?: string | null) {
  if (kind === "reply") return "Reply from"
  if (kind === "notice") return "Notice from"
  if (kind === "completed") return "Completed"
  if (kind === "failed") return "Failed"
  if (actor === "user") return "Interrupted by User"
  if (actor === "agent") return "Interrupted by Agent"
  return "Interrupted"
}

export function toolText(input: {
  tool: string
  alias: string
  width: number
  status?: string
  started?: boolean
  waiting?: boolean
  reason?: string
  actor?: string
  events?: readonly {
    kind: "reply" | "notice" | "completed" | "failed" | "interrupted"
    alias: string
    actor?: string | null
  }[]
}) {
  const route = `\`${input.alias.length > Math.max(12, input.width - 28) ? `${input.alias.slice(0, Math.max(11, input.width - 29))}…` : input.alias}\``
  if (input.tool === "agent_spawn") return `${input.started ? "Started" : "Queued"} ${route}`
  if (input.tool === "agent_connect") return `Connected ${route}`
  if (input.tool === "agent_interact") return `Interacted with ${route}${input.status ? ` · ${input.status}` : ""}`
  if (input.tool === "agent_inspect") return "Checked Agent status"
  if (input.tool === "agent_interrupt")
    return `${input.status === "interrupted" ? "Interrupted" : input.status === "idle" ? "Idle" : "Interrupting"} ${route}`
  if (input.waiting) return "Waiting for subagents"
  if (input.events?.length)
    return `Finished waiting\n${input.events.map((item) => `  └ ${label(item.kind, item.actor)} \`${item.alias.length > Math.max(12, input.width - 32) ? `${item.alias.slice(0, Math.max(11, input.width - 33))}…` : item.alias}\``).join("\n")}`
  if (input.reason === "timeout") return "Finished waiting\n  └ No agents completed yet"
  if (input.reason === "parent_input") return "Finished waiting\n  └ Interrupted by user input"
  if (input.reason === "interrupted") return `Finished waiting\n  └ ${label("interrupted", input.actor)}`
  if (input.reason === "reply") return "Finished waiting\n  └ Reply received"
  if (input.reason === "completed") return "Finished waiting\n  └ Result received"
  return "Finished waiting"
}

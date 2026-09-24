import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionDurableEvent } from "@opencode-ai/sdk/v2"
import type { RunFilePart, RunPromptPart } from "./types"

export async function selectPromptBackend(input: {
  sdk: OpencodeClient
  sessionID: string
  backgroundSubagents: boolean
}): Promise<"v2" | "legacy"> {
  if (!input.backgroundSubagents) return "legacy"
  const response = await input.sdk.v2.session.promptBackend({ sessionID: input.sessionID })
  if (response.response.status === 404 || response.response.status === 501) return "legacy"
  if (response.error || (response.data?.data !== "v2" && response.data?.data !== "legacy"))
    throw new Error(`Prompt backend unavailable (${response.response.status})`)
  return response.data.data
}

export function canonicalPrompt(input: { text: string; files: RunFilePart[]; parts: RunPromptPart[] }) {
  if (input.parts.some((part) => part.type === "subtask"))
    throw new Error("Subtask prompt parts require the legacy prompt backend")
  return {
    text: [input.text, ...input.parts.filter((part) => part.type === "text").map((part) => part.text)].join("\n"),
    files: [...input.files, ...input.parts.filter((part) => part.type === "file")].map((part) => ({
      uri: part.url,
      name: part.filename,
      mime: part.mime,
      ...("source" in part && part.source
        ? { source: { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value } }
        : {}),
    })),
    agents: input.parts.filter((part) => part.type === "agent").map((part) => ({
      name: part.name,
      ...(part.source
        ? { source: { start: part.source.start, end: part.source.end, text: part.source.value } }
        : {}),
    })),
  }
}

export async function awaitCanonicalTurn(input: {
  sdk: OpencodeClient
  sessionID: string
  messageID: string
  admittedSeq: number
  signal?: AbortSignal
}) {
  const events = await input.sdk.v2.session.events(
    { sessionID: input.sessionID, after: String(input.admittedSeq) },
    { signal: input.signal, throwOnError: true },
  )
  const assistants = new Set<string>()
  const content: Array<{ type: "text" | "reasoning"; text: string }> = []
  let promoted = false
  for await (const packet of events.stream) {
    // The generated SSE type describes the wire envelope; the SDK stream yields its decoded event.
    const event = packet as unknown as SessionDurableEvent
    if (event.type === "session.next.prompted" && event.data.messageID === input.messageID) promoted = true
    if (promoted && event.type === "session.next.step.started") assistants.add(event.data.assistantMessageID)
    if (
      promoted && event.type === "session.next.text.ended" &&
      assistants.has(event.data.assistantMessageID)
    ) content.push({ type: "text", text: event.data.text })
    if (
      promoted && event.type === "session.next.reasoning.ended" &&
      assistants.has(event.data.assistantMessageID)
    ) content.push({ type: "reasoning", text: event.data.text })
    if (event.type === "session.next.turn.settled" && event.data.messageID === input.messageID)
      return { outcome: event.data.outcome, content }
  }
  throw new Error("Canonical turn event stream closed before settlement")
}

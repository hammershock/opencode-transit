import type { OpencodeClient } from "@opencode-ai/sdk/v2"

// Inspector metadata only: never attach this count to a model-context generation or message.
export async function loadCompactionCount(client: OpencodeClient, sessionID: string, signal: AbortSignal) {
  const [checkpoints, legacy] = await Promise.all([
    completedCheckpoints(client, sessionID, signal),
    client.session.messages({ sessionID }, { throwOnError: true, signal }),
  ])
  const parents = new Set(
    legacy.data
      .filter((message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"))
      .map((message) => message.info.id),
  )
  for (const message of legacy.data) {
    const info = message.info
    if (info.role !== "assistant" || !info.summary || !info.finish || info.error || !parents.has(info.parentID))
      continue
    if (!message.parts.some((part) => part.type === "text" && part.text.trim())) continue
    checkpoints.add(info.id)
  }
  return checkpoints.size
}

async function completedCheckpoints(client: OpencodeClient, sessionID: string, signal: AbortSignal) {
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    signal.throwIfAborted()
    const response = await client.v2.session.messages(
      { sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" as const }) },
      { throwOnError: true, signal },
    )
    for (const message of response.data.data) {
      if (message.type === "compaction") ids.add(message.id)
    }
    const next = response.data.cursor.next
    if (!response.data.data.length || !next) return ids
    if (cursors.has(next)) throw new Error("Compaction history pagination did not advance")
    cursors.add(next)
    cursor = next
  }
}

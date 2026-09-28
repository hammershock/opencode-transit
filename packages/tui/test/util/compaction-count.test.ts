import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { loadCompactionCount } from "../../src/util/compaction-count"

test("counts completed checkpoints across pages and successful legacy summaries", async () => {
  const requests: URL[] = []
  const client = historyClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push(url)
      if (!url.pathname.startsWith("/api/"))
        return Response.json([
          { info: { id: "request", role: "user" }, parts: [{ type: "compaction" }] },
          ...[
            { id: "successful" },
            { id: "failed", error: { name: "UnknownError" } },
            { id: "unfinished", finish: undefined },
            { id: "orphan", parentID: "missing" },
          ].map((info) => ({
            info: { role: "assistant", summary: true, finish: "stop", parentID: "request", ...info },
            parts: [{ type: "text", text: "summary" }],
          })),
        ])
      const cursor = url.searchParams.get("cursor")
      if (cursor) expect(url.searchParams.has("order")).toBe(false)
      return Response.json(
        cursor === "end"
          ? { data: [], cursor: {} }
          : {
              data: cursor
                ? [
                    { id: "old", type: "compaction" },
                    { id: "new", type: "compaction" },
                  ]
                : [
                    { id: "new", type: "compaction" },
                    { id: "user", type: "user" },
                  ],
              cursor: { next: cursor ? "end" : "older" },
            },
      )
    },
  })
  expect(await loadCompactionCount(client, "session", new AbortController().signal)).toBe(3)
  expect(requests.filter((url) => url.pathname.startsWith("/api/"))).toHaveLength(3)
})

test("returns zero for empty history and rejects unavailable or aborted history", async () => {
  const empty = historyClient({
    baseUrl: "http://localhost",
    fetch: async (input) =>
      Response.json(
        new URL(input instanceof Request ? input.url : String(input)).pathname.startsWith("/api/")
          ? { data: [], cursor: {} }
          : [],
      ),
  })
  expect(await loadCompactionCount(empty, "session", new AbortController().signal)).toBe(0)
  const failed = historyClient({
    baseUrl: "http://localhost",
    fetch: async () => new Response("unavailable", { status: 503 }),
  })
  await expect(loadCompactionCount(failed, "session", new AbortController().signal)).rejects.toBeDefined()
  const abort = new AbortController()
  abort.abort()
  await expect(loadCompactionCount(empty, "session", abort.signal)).rejects.toBeDefined()
})

test("rejects repeated history cursors instead of displaying a partial count", async () => {
  const client = historyClient({
    baseUrl: "http://localhost",
    fetch: async (input) =>
      Response.json(
        new URL(input instanceof Request ? input.url : String(input)).pathname.startsWith("/api/")
          ? { data: [{ id: "one", type: "compaction" }], cursor: { next: "same" } }
          : [],
      ),
  })
  await expect(loadCompactionCount(client, "session", new AbortController().signal)).rejects.toThrow(
    "pagination did not advance",
  )
})

function historyClient(config: { baseUrl: string; fetch: (input: RequestInfo | URL) => Promise<Response> }) {
  return createOpencodeClient({ ...config, fetch: Object.assign(config.fetch, { preconnect: fetch.preconnect }) })
}

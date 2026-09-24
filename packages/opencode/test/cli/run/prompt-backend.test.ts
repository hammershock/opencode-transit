import { expect, test } from "bun:test"
import type { OpencodeClient, SessionDurableEvent } from "@opencode-ai/sdk/v2"
import { awaitCanonicalTurn, canonicalPrompt } from "@/cli/cmd/run/prompt-backend"

function eventClient(events: SessionDurableEvent[]): OpencodeClient {
  return {
    v2: {
      session: {
        events: async () => ({ stream: (async function* () { yield* events })() }),
      },
    },
  } as unknown as OpencodeClient
}

test("mini V2 prompt retains text, file MIME and source, and agent mention spans", () => {
  expect(canonicalPrompt({
    text: "inspect @cache @general",
    files: [{ type: "file", url: "data:image/png;base64,AAAA", filename: "sample.png", mime: "image/png" }],
    parts: [
      {
        type: "file",
        url: "file:///tmp/cache",
        filename: "cache",
        mime: "application/x-directory",
        source: { type: "file", path: "/tmp/cache", text: { value: "@cache", start: 8, end: 14 } },
      },
      { type: "agent", name: "general", source: { value: "@general", start: 15, end: 23 } },
      { type: "text", text: "extra context" },
    ],
  })).toEqual({
    text: "inspect @cache @general\nextra context",
    files: [
      { uri: "data:image/png;base64,AAAA", name: "sample.png", mime: "image/png" },
      {
        uri: "file:///tmp/cache",
        name: "cache",
        mime: "application/x-directory",
        source: { text: "@cache", start: 8, end: 14 },
      },
    ],
    agents: [{ name: "general", source: { text: "@general", start: 15, end: 23 } }],
  })
})

test("mini V2 prompt refuses a legacy subtask part instead of dropping it", () => {
  expect(() => canonicalPrompt({
    text: "inspect",
    files: [],
    parts: [{ type: "subtask", prompt: "work", description: "work", agent: "general" }],
  })).toThrow("Subtask prompt parts require the legacy prompt backend")
})

test("canonical turn reports exact failed settlement without consuming another turn", async () => {
  const events = [
    { type: "session.next.prompted", data: { messageID: "input-a" } },
    { type: "session.next.step.started", data: { assistantMessageID: "assistant-a" } },
    { type: "session.next.text.ended", data: { assistantMessageID: "assistant-a", text: "partial answer" } },
    { type: "session.next.turn.settled", data: { messageID: "input-a", outcome: "failed" } },
    { type: "session.next.text.ended", data: { assistantMessageID: "assistant-b", text: "wrong turn" } },
  ] as SessionDurableEvent[]
  expect(await awaitCanonicalTurn({ sdk: eventClient(events), sessionID: "session", messageID: "input-a", admittedSeq: 1 }))
    .toEqual({ outcome: "failed", content: [{ type: "text", text: "partial answer" }] })
})

test("canonical turn exposes a closed event stream as an unavailable error", async () => {
  await expect(awaitCanonicalTurn({ sdk: eventClient([]), sessionID: "session", messageID: "input-a", admittedSeq: 1 }))
    .rejects.toThrow("closed before settlement")
})

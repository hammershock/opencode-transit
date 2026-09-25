import { expect, test } from "bun:test"
import { AgentTimeline } from "../src/util/agent-timeline"

test("keeps call anchors and receiver activity in durable order across replay", () => {
  const messages = [
    { id: "spawn-a", time: { created: 1 } },
    { id: "spawn-b", time: { created: 2 } },
    { id: "timeout", time: { created: 3 } },
    { id: "progress", time: { created: 4 } },
    { id: "answer", time: { created: 5 } },
  ]
  const anchors = new Map(messages.map((message, index) => [message.id, [1, 3, 5, 9, 13][index]!] as const))
  const activities = [
    { id: "b-done", seq: 4, waitCallID: null },
    { id: "reply", seq: 10, waitCallID: "wait-1" },
    { id: "a-done", seq: 15, waitCallID: null },
  ]
  const expected = [
    "message:spawn-a",
    "message:spawn-b",
    "activity:b-done",
    "message:timeout",
    "message:progress",
    "message:answer",
    "activity:a-done",
  ]
  expect(AgentTimeline.order({ messages, anchors, activities, readyAt: 20 })).toEqual(expected)
  expect(AgentTimeline.order({ messages, anchors, activities: activities.toReversed(), readyAt: 20 })).toEqual(expected)
  expect(AgentTimeline.order({ messages, anchors, activities: activities.slice(0, 2), readyAt: 20 })).toEqual(
    expected.slice(0, -1),
  )
})

test("places a completion before the answer that consumed it within one assistant message", () => {
  const messages = [{ id: "assistant", role: "assistant", time: { created: 1 } }]
  const anchors = new Map([
    ["assistant", 1],
    ["spawn-call", 2],
    ["wait-call", 4],
    ["answer-text", 8],
    ["footer:assistant", 9],
  ])
  const parts = new Map([["assistant", [{ id: "spawn-call" }, { id: "wait-call" }, { id: "answer-text" }]]])
  const activities = [{ id: "completed", seq: 6, waitCallID: null }]
  expect(AgentTimeline.order({ messages, anchors, parts, activities, readyAt: 20 })).toEqual([
    "part:assistant:spawn-call",
    "part:assistant:wait-call",
    "activity:completed",
    "part:assistant:answer-text",
    "footer:assistant",
  ])
})

test("holds a new message until its receiver sequence arrives and keeps old history readable", () => {
  const messages = [
    { id: "old", time: { created: 1 } },
    { id: "new", time: { created: 30 } },
  ]
  expect(
    AgentTimeline.order({
      messages,
      anchors: new Map(),
      activities: [{ id: "late", seq: 8, waitCallID: null }],
      readyAt: 20,
    }),
  ).toEqual(["message:old", "activity:late"])
  expect(
    AgentTimeline.order({
      messages,
      anchors: new Map([["new", 7]]),
      activities: [{ id: "late", seq: 8, waitCallID: null }],
      readyAt: 20,
    }),
  ).toEqual(["message:old", "message:new", "activity:late"])
})

test("shows authenticated interruption actor without assigning one to legacy records", () => {
  expect(AgentTimeline.label("interrupted", "user")).toBe("Interrupted by User")
  expect(AgentTimeline.label("interrupted", "agent")).toBe("Interrupted by Agent")
  expect(AgentTimeline.label("interrupted", null)).toBe("Interrupted")
})

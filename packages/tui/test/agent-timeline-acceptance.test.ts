import { expect, test } from "bun:test"
import { AgentTimeline } from "../src/util/agent-timeline"

const messages = [
  { id: "assistant-1", role: "assistant", time: { created: 1 } },
  { id: "user-progress", role: "user", time: { created: 2 } },
  { id: "assistant-2", role: "assistant", time: { created: 3 } },
  { id: "user-next", role: "user", time: { created: 4 } },
  { id: "assistant-3", role: "assistant", time: { created: 5 } },
]
const parts = new Map([
  ["assistant-1", [{ id: "spawn-a" }, { id: "spawn-b" }, { id: "start-text" }]],
  ["assistant-2", [{ id: "interact" }, { id: "wait-1" }, { id: "progress-text" }]],
  ["assistant-3", [{ id: "wait-2" }, { id: "final-text" }]],
])
const anchors = new Map([
  ["assistant-1", 0], ["spawn-a", 1], ["spawn-b", 3], ["start-text", 5], ["footer:assistant-1", 6],
  ["user-progress", 7], ["assistant-2", 8], ["interact", 9], ["wait-1", 10],
  ["progress-text", 14], ["footer:assistant-2", 15], ["user-next", 16],
  ["assistant-3", 17], ["wait-2", 18], ["final-text", 23], ["footer:assistant-3", 24],
])
const activities = [
  { id: "b-finished", seq: 4, waitCallID: null },
  { id: "progress-reply", seq: 11, waitCallID: "wait-1" },
  { id: "a-notice", seq: 12, waitCallID: null },
  { id: "a-finished", seq: 20, waitCallID: "wait-2" },
  { id: "late-notice", seq: 25, waitCallID: null },
]
const expected = [
  "part:assistant-1:spawn-a", "part:assistant-1:spawn-b", "activity:b-finished",
  "part:assistant-1:start-text", "footer:assistant-1", "message:user-progress",
  "part:assistant-2:interact", "part:assistant-2:wait-1", "activity:a-notice",
  "part:assistant-2:progress-text", "footer:assistant-2", "message:user-next",
  "part:assistant-3:wait-2", "part:assistant-3:final-text", "footer:assistant-3",
  "activity:late-notice",
]

test("parallel completion, progress reply, two Waits and late notice have one replay order", () => {
  const live = AgentTimeline.order({ messages, parts, anchors, activities, readyAt: 30 })
  const replay = AgentTimeline.order({ messages, parts, anchors, activities: activities.toReversed(), readyAt: 30 })
  expect(live).toEqual(expected)
  expect(replay).toEqual(expected)
  expect(live.filter((row) => row.includes("finished"))).toEqual(["activity:b-finished"])
  expect(live).not.toContain("activity:progress-reply")
  expect(live).not.toContain("activity:a-finished")
})

test("pagination and out-of-order network pages converge without moving call rows", () => {
  const early = AgentTimeline.order({
    messages: messages.slice(0, 3), parts, anchors: new Map([...anchors].filter(([, seq]) => seq <= 15)),
    activities: activities.filter((item) => item.seq <= 15), readyAt: 30,
  })
  expect(early).toEqual(expected.slice(0, 11))
  expect(AgentTimeline.order({ messages, parts, anchors, activities, readyAt: 30 })).toEqual(expected)
})

test("a timed out Wait never absorbs a later completion", () => {
  const rows = AgentTimeline.order({
    messages: [{ id: "timeout", time: { created: 1 } }, { id: "user", time: { created: 2 } }],
    anchors: new Map([["timeout", 1], ["user", 3]]),
    activities: [{ id: "done-after-timeout", seq: 4, waitCallID: null }], readyAt: 5,
  })
  expect(rows).toEqual(["message:timeout", "message:user", "activity:done-after-timeout"])
  expect(AgentTimeline.toolText({ tool: "agent_wait", alias: "/root/a", width: 72, reason: "timeout" }))
    .toBe("Finished waiting\n  └ No agents completed yet")
})

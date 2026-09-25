import { expect, test } from "bun:test"
import { taskInvocationMatches, taskReceiptID } from "../../src/util/task-card"

test("Task receipt supplies only a child ID hint", () => {
  expect(taskReceiptID('<task id="ses_child123" state="admitted">\n</task>')).toBe("ses_child123")
  expect(taskReceiptID("A model wrote ses_child123")).toBeUndefined()
})

test("a reused child is associated with the exact parent Task call", () => {
  const view = {
    target: {
      task_id: "ses_child123",
      invocation: { parent_session_id: "ses_parent", parent_message_id: "msg_new", call_id: "call_new" },
    },
  } as Parameters<typeof taskInvocationMatches>[0]
  expect(taskInvocationMatches(view, "ses_parent", "msg_new", "call_new")).toBe(true)
  expect(taskInvocationMatches(view, "ses_parent", "msg_old", "call_old")).toBe(false)
  expect(taskInvocationMatches(view, "ses_other", "msg_new", "call_new")).toBe(false)
})

import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionTask } from "../src/session-task"
import { SessionID } from "../src/session-id"

test("task wait accepts RFC timeout bounds and rejects values outside them", () => {
  const decode = Schema.decodeUnknownSync(SessionTask.WaitRequest)
  const targets = [{
    task_id: SessionID.make("ses_child"),
    invocation: { parent_session_id: SessionID.make("ses_parent"), parent_message_id: "msg_parent", call_id: "call_task" },
    input_id: "msg_child",
  }]
  expect(decode({ targets, timeout_ms: 1 })).toEqual({ targets, timeout_ms: 1 })
  expect(decode({ targets, timeout_ms: 120_000 })).toEqual({ targets, timeout_ms: 120_000 })
  expect(() => decode({ targets, timeout_ms: 0 })).toThrow()
  expect(() => decode({ targets, timeout_ms: 120_001 })).toThrow()
  expect(() => decode({ targets: [{ task_id: "ses_child" }] })).toThrow()
})

import { expect, test } from "bun:test"
import { SessionAgentGuidance } from "@opencode-ai/core/session/agent-guidance"

test("Agent guidance turns ordinary progress questions into Interact and continued work", () => {
  const guidance = SessionAgentGuidance.render(["/root/review", "/root/check"])
  expect(guidance).toContain("/root/review, /root/check")
  expect(guidance).toContain("How is that task going?")
  expect(guidance).toContain("directly call agent_interact")
  expect(guidance).toContain("then continue your original work")
  expect(guidance).toContain("Do not ask the user for permission")
  expect(guidance).toContain("它是否还在运行？")
  expect(guidance).toContain("call agent_inspect")
  expect(guidance).toContain("do not send a message to that Agent or wait for a reply")
  expect(guidance).toContain("具体完成了什么？")
  expect(guidance).toContain("admitted, delivered and replied")
})

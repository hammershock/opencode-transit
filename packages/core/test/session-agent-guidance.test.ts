import { expect, test } from "bun:test"
import { SessionAgentGuidance } from "@opencode-ai/core/session/agent-guidance"

test("Agent guidance turns ordinary progress questions into Interact and continued work", () => {
  const guidance = SessionAgentGuidance.render(["/root/review", "/root/check"])
  expect(guidance).toContain("/root/review, /root/check")
  expect(guidance).toContain("How is that task going?")
  expect(guidance).toContain("directly call agent_interact")
  expect(guidance).toContain("then continue its original task if it is still active")
  expect(guidance).toContain("Continue your original work only if its execution is still active")
  expect(guidance).toContain("Do not ask the user for permission")
  expect(guidance).toContain("它是否还在运行？")
  expect(guidance).toContain("call only agent_inspect")
  expect(guidance).toContain("Do not call agent_interact or agent_wait for this question")
  expect(guidance).toContain("具体完成了什么？")
  expect(guidance).toContain("admitted, delivered and replied")
  expect(guidance).toContain("A later request to summarize or ask what happened calls for a factual reply only")
  expect(guidance).toContain("Resume that work only when a new user or authorized contact request explicitly asks to continue")
  expect(guidance).toContain("An authorized contact may explicitly resume or adjust the remaining work it delegated")
})

test("Agent guidance includes authenticated interruption without treating a summary as continuation", () => {
  const guidance = SessionAgentGuidance.render(
    ["/contacts/requester_123"],
    { actor: "agent" },
    ["/contacts/requester_123"],
  )
  expect(guidance).toContain("the previous execution was interrupted by agent")
  expect(guidance).toContain("A summary request is not permission to resume it")
  expect(guidance).toContain("report the authenticated actor agent")
  expect(guidance).toContain("Authenticated delegation: /contacts/requester_123 assigned this task")
  expect(guidance).toContain("Do not demand a direct user message in this Session")
  expect(SessionAgentGuidance.render([])).not.toContain("Authenticated Session state")
  expect(SessionAgentGuidance.render([])).not.toContain("Authenticated delegation")
})

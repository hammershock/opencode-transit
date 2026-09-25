import { expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { render } from "@/tool/available-subagents"

test("renders only subagent candidates with escaped and bounded descriptions", () => {
  const reviewer = AgentV2.Info.make({
    ...AgentV2.Info.empty(AgentV2.ID.make("reviewer")),
    mode: "subagent",
    description: "Reviews <code> & tests",
  })
  const primary = AgentV2.Info.make({
    ...AgentV2.Info.empty(AgentV2.ID.make("build")),
    mode: "primary",
  })
  expect(render([primary])).toBeUndefined()
  expect(render([reviewer, primary])).toContain('<subagent id="reviewer">Reviews &lt;code&gt; &amp; tests</subagent>')
  expect(Buffer.byteLength(render(Array.from({ length: 100 }, (_, index) => ({
    ...reviewer,
    id: AgentV2.ID.make(`reviewer-${index}`),
  }))) ?? "")).toBeLessThanOrEqual(8192)
})

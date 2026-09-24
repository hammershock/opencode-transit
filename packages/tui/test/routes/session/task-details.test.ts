import { expect, test } from "bun:test"
import { taskDetails } from "../../../src/routes/session/dialog-task"

test("Task detail shows remote placement, owner freshness and bounded tool names", () => {
  const view = {
    location: { target_id: "remote-1", target_name: "Lab GPU", directory: "/tmp/task-569" },
    runtime: "observed",
    read_at: 1_000,
    runtime_observation: { source: "execution_owner", owner_generation: "owner-1", observed_at: 900 },
    last_progress_at: 800,
    active_tool_count: 5,
    active_tools: ["bash", "read", "edit", "grep", "hidden"].map((name) => ({ name, call_id: name })),
  } as Parameters<typeof taskDetails>[0]
  const details = taskDetails(view)
  expect(details).toContain("Location Lab GPU · /tmp/task-569")
  expect(details.some((item) => item.startsWith("Owner observed "))).toBe(true)
  expect(details.some((item) => item.startsWith("Last progress "))).toBe(true)
  expect(details).toContain("Active tools 5 · bash, read, edit, grep, …")
  expect(details.join(" ")).not.toContain("hidden")
})

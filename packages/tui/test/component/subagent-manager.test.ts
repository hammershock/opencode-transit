import { describe, expect, test } from "bun:test"
import type { SubagentEntry } from "@opencode-ai/sdk/v2"
import {
  parseSubagentPermission,
  subagentCapability,
  subagentColumnWidths,
  subagentProfile,
  subagentRow,
} from "../../src/component/subagent-manager"

function entry(input: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    id: "reviewer",
    name: "Reviewer",
    description: "Review changes and run focused checks",
    model: { providerID: "openai", modelID: "gpt-6-astra" },
    effective: "active",
    reason: "default",
    approvalRequired: false,
    capabilities: ["full-access", "shell", "delegation"],
    editable: true,
    source: "global",
    ...input,
  }
}

describe("subagent manager presentation", () => {
  test("renders the effective state and bounded one-line columns", () => {
    const wide = subagentRow(entry(), 140)
    const narrow = subagentRow(entry({ effective: "inactive" }), 70)

    expect(wide).toContain("●")
    expect(wide).toContain("Reviewer")
    expect(wide).toContain("openai/gpt-6-astra")
    expect(wide).toContain("Full access")
    expect(narrow).toContain("○")
    expect(narrow.split("\n")).toHaveLength(1)
    expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(70)
    expect(subagentColumnWidths(70).description).toBeGreaterThanOrEqual(12)
  })

  test("uses conservative capability labels for custom rules", () => {
    expect(subagentCapability(entry({ permission: undefined, capabilities: ["read-only", "no-delegation"] }))).toBe(
      "Read only",
    )
    expect(subagentCapability(entry({ permission: { edit: "allow" }, capabilities: ["workspace-write"] }))).toBe(
      "Write",
    )
    expect(subagentCapability(entry({ permission: { bash: { "git *": "ask" } }, capabilities: ["restricted"] }))).toBe(
      "Custom",
    )
  })

  test("recognizes exact profiles and preserves valid custom permission maps", () => {
    expect(
      subagentProfile({
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        list: "allow",
        webfetch: "allow",
        websearch: "allow",
        task: "deny",
      }),
    ).toBe("read-only")
    expect(parseSubagentPermission('{"read":"allow","bash":{"git *":"ask","*":"deny"}}')).toEqual({
      read: "allow",
      bash: { "git *": "ask", "*": "deny" },
    })
    expect(() => parseSubagentPermission('{"read":"sometimes"}')).toThrow("Invalid rule for read")
  })
})

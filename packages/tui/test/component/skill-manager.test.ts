import { describe, expect, test } from "bun:test"
import {
  buildSkillManagerRows,
  buildSkillPathRows,
  skillRootStatus,
  skillAgentChoices,
  skillAgentsLabel,
  skillPreviewContent,
  skillScopeLabel,
  skillSourceLabel,
  skillTargetsLabel,
  toggleSkillTargetScope,
  type SkillManagerModel,
} from "../../src/component/skill-manager"

const firstID = `skl_${"1".repeat(64)}`
const secondID = `skl_${"2".repeat(64)}`
const dormantID = `skl_${"3".repeat(64)}`

function model(): SkillManagerModel {
  return {
    settings: {
      path: "/Users/test/.config/opencode/opencode.jsonc",
      revision: "revision",
      roots: [
        {
          kind: "opencode-global",
          value: "/Users/test/.config/opencode/skills",
          resolved: "/Users/test/.config/opencode/skills",
          default: true,
          status: "ready",
        },
        {
          kind: "imported",
          value: "/Users/test/.codex/skills",
          resolved: "/Users/test/.codex/skills",
          default: false,
          status: "undetected",
        },
      ],
      targets: { [secondID]: ["local"], [dormantID]: [] },
      diagnostics: [
        {
          kind: "missing-target",
          severity: "warning",
          field: `skills.targets.${secondID}`,
          message: "Configured target is missing on this device",
          skillID: secondID,
          targetID: "missing-target",
        },
      ],
      valid: true,
    },
    catalog: {
      revision: "catalog-revision",
      digest: "catalog-digest",
      skills: [
        { id: firstID, name: "review", sourceLabel: "OpenCode config · first", digest: "first" },
        { id: secondID, name: "review", sourceLabel: "Imported · second", digest: "second" },
      ],
      diagnostics: [
        {
          kind: "duplicate-name",
          severity: "warning",
          sourceLabel: "Registry",
          message: "Skill name is ambiguous",
        },
      ],
    },
    targets: [{ id: "configured-target", name: "a100-2gpu" }],
  }
}

describe("Skill Manager presentation", () => {
  test("uses stable status labels for roots and target scopes", () => {
    expect(skillRootStatus(model().settings.roots[0]!)).toBe("● default")
    expect(skillRootStatus(model().settings.roots[1]!)).toBe("! undetected")
    expect(skillScopeLabel(undefined)).toBe("all")
    expect(skillScopeLabel("*")).toBe("all")
    expect(skillScopeLabel([])).toBe("none")
    expect(skillScopeLabel(["local"])).toBe("local")
    expect(skillTargetsLabel(["local", "configured-target"], model().targets)).toBe("local, a100-2gpu")
    expect(skillSourceLabel("Built-in")).toBe("opencode")
    expect(skillSourceLabel("Codex · abcdef12")).toBe("codex")
    expect(skillSourceLabel("Claude · abcdef12")).toBe("claude")
    expect(skillSourceLabel("Imported · abcdef12")).toBe("others")
  })

  test("selects by names without exposing IDs and blocks ambiguous existing names", () => {
    const agents = [
      { id: "agent-private-1", name: "Paper Reviewer", mode: "subagent" as const, hidden: false },
      { id: "agent-private-2", name: "Coordinator", mode: "primary" as const, hidden: false },
      { id: "agent-private-3", name: "  ＰＡＰＥＲ Reviewer  ", mode: "subagent" as const, hidden: true },
    ]
    const scope = ["agent-private-1", "agent-deleted"]
    expect(skillAgentsLabel(scope, agents)).toBe("Paper Reviewer, Unavailable Agent")
    const choices = skillAgentChoices(scope, agents)
    expect(choices.find((choice) => choice.value === "agent-private-1")).toMatchObject({ blocked: true })
    expect(choices.find((choice) => choice.value === "agent-private-2")).toMatchObject({
      blocked: false,
      category: "Primary agents",
    })
    expect(choices.find((choice) => choice.value === "agent-deleted")).toMatchObject({ title: "[x] Unavailable Agent" })
    for (const choice of choices) expect(`${choice.title} ${choice.description}`).not.toContain(choice.value)
    const current = model()
    expect(
      buildSkillManagerRows({ ...current, settings: { ...current.settings, agents: { [firstID]: [] } } })[0]?.skill
        ?.state,
    ).toBe("inactive")
  })

  test("switches from future-inclusive access to an explicit checklist", () => {
    expect(toggleSkillTargetScope("*", "local", ["local", "configured-target"])).toEqual(["configured-target"])
    expect(toggleSkillTargetScope(["local"], "configured-target")).toEqual(["local", "configured-target"])
    expect(toggleSkillTargetScope(["local", "configured-target"], "local")).toEqual(["configured-target"])
    expect(toggleSkillTargetScope(["configured-target"], "configured-target")).toEqual([])
  })

  test("keeps duplicate source identity and hides dormant target overrides", () => {
    const rows = buildSkillManagerRows(model())
    expect(rows.every((row) => row.category === "Skills")).toBe(true)
    expect(buildSkillPathRows(model().settings, "/Users/test")[1]).toMatchObject({
      title: "~/.codex/skills",
      footer: "! undetected",
      inspectionTitle: "/Users/test/.codex/skills",
    })
    expect(rows.filter((row) => row.title === "review")).toEqual([
      expect.objectContaining({
        skill: { source: "opencode", targets: "all", state: "active" },
        details: [expect.stringContaining("Duplicate"), "Agents: all"],
      }),
      expect.objectContaining({ skill: { source: "others", targets: "local", state: "active" } }),
    ])
    expect(rows.find((row) => row.key === `skill:${dormantID}`)).toBeUndefined()
    expect(rows.filter((row) => row.category === "Skills")).toHaveLength(2)
  })

  test("keeps unavailable paths and their diagnostics in the dedicated path list", () => {
    const current = model()
    const rows = buildSkillPathRows({
      ...current.settings,
      roots: [...current.settings.roots, { kind: "imported", value: "/broken", default: false, status: "unavailable" }],
      diagnostics: [
        {
          kind: "invalid-path",
          severity: "warning",
          field: "skills.paths.1",
          message: "Skill directory is unavailable (EIO)",
        },
      ],
    })
    expect(rows[2]).toMatchObject({
      title: "/broken",
      footer: "! unavailable",
      details: ["Skill directory is unavailable (EIO)"],
    })
    expect(rows).toHaveLength(3)
  })

  test("formats safe metadata and the complete Skill entry body for preview", () => {
    expect(
      skillPreviewContent(
        {
          metadata: {
            id: firstID,
            name: "review",
            description: "Review changes",
            sourceLabel: "Codex · abcdef12",
            digest: "a".repeat(64),
          },
          location: "/Users/test/.codex/skills/review/SKILL.md",
          content: "# Review\n\nRead every changed file.",
        },
        "/Users/test",
      ),
    ).toBe(
      [
        "Name         review",
        "Description  Review changes",
        "Source       Codex · abcdef12",
        "Entry        ~/.codex/skills/review/SKILL.md",
        `Digest       ${"a".repeat(64)}`,
        "",
        "SKILL.md",
        "# Review",
        "",
        "Read every changed file.",
      ].join("\n"),
    )
  })
})

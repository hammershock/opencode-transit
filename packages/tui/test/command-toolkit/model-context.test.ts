import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver } from "@opencode-ai/command-kit"
import {
  modelContextCommand,
  subagentRefreshToast,
  type ModelContextCommandContext,
  type ModelContextGeneration,
} from "../../src/command-toolkit/model-context"
import { modelContextOptions } from "../../src/component/dialog-model-context"

const generation: ModelContextGeneration = {
  freshInstructions: [
    {
      id: "global",
      origin: "global-file",
      scope: "global",
      source: "/controller/AGENTS.md",
      status: "loaded",
      content: "global rules",
      digest: "1111111111111111",
    },
    {
      id: "target",
      origin: "target-file",
      scope: "target",
      source: "<target-config>/AGENTS.md",
      status: "loaded",
      content: "target rules",
      digest: "2222222222222222",
    },
    {
      id: "project",
      origin: "project-file",
      scope: "project",
      source: "/workspace/project/AGENTS.md",
      status: "ignored",
      failureStage: "read",
    },
  ],
  skillCatalog: {
    digest: "bbbbbbbbbbbbbbbb",
    skills: [
      {
        id: `skl_${"1".repeat(64)}`,
        name: "review-agent",
        sourceLabel: "Imported",
        digest: "cccccccccccccccc",
      },
    ],
  },
  skillGuidance: "<available_skills>\n  <skill><name>review-agent</name></skill>\n</available_skills>",
  runtimeParts: [
    {
      key: "environment",
      label: "Environment",
      tag: "<environment>",
      text: "environment body",
    },
    {
      key: "date",
      label: "Date",
      tag: "<date>",
      text: "Current date: Sat Sep 20 2026\nUser timezone: UTC",
    },
    {
      key: "instructions",
      label: "Instructions",
      tag: "<instructions>",
      text: "<instructions>\n  global rules\n  target rules\n</instructions>",
    },
    {
      key: "references",
      label: "References",
      tag: "<available_references>",
      text: "<available_references>\n  <reference><name>example</name></reference>\n</available_references>",
    },
    {
      key: "skills",
      label: "Available skills",
      tag: "<available_skills>",
      text: "<available_skills>\n  <skill><name>review-agent</name></skill>\n</available_skills>",
    },
  ],
  environmentInfo: {
    harness: "OpenCode Transit",
    entrypoint: "opencode-transit",
    targetKind: "rexd",
    targetName: "mywindows",
    directory: "/workspace/project",
    projectRoot: "/workspace/project",
    platform: "linux",
  },
  subagentCatalog: {
    revision: "dddddddddddddddd",
    activatedAt: "2026-09-15T08:00:00.000Z",
    status: "partial",
    agents: [
      {
        agent: "research",
        model: { providerID: "openai", modelID: "gpt-5" },
        pricing: {
          status: "available",
          input: 1.25,
          output: 10,
          cacheRead: 0.125,
          cacheWrite: 0,
          tiers: [],
          currency: "USD",
          unit: "1M_tokens",
          source: "model_catalog",
        },
        billing: { mode: "unknown" },
        benchmarks: [
          {
            dimension: "research",
            benchmark: "ResearchBench",
            value: 82,
            unit: "%",
            source: "benchmark-source",
            observedAt: "2026-09-14T08:00:00.000Z",
            datasetVersion: "2026-09",
            modelVariant: "gpt-5",
            attribution: "benchmark-source",
            status: "stale",
          },
        ],
      },
    ],
    diagnostics: ["Usage data unavailable"],
    truncated: true,
  },
  subagentGuidance:
    '<available_subagents status="partial" refreshed_at="2026-09-15T08:00:00.000Z" truncated="true">\n</available_subagents>',
  subagentRefresh: {
    status: "partial",
    completedAt: "2026-09-15T08:00:00.000Z",
    diagnostics: ["Usage data unavailable"],
  },
  tools: [
    {
      name: "read",
      description: "Read a file from the local filesystem.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "grep",
      description: "Search file contents with a regular expression.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
    },
  ],
}

describe("model context inspector", () => {
  test("shows a legacy compaction summary without the V2 checkpoint wrapper", () => {
    const options = modelContextOptions({
      ...generation,
      compaction: {
        source: "legacy",
        reason: "auto",
        summary: "Earlier work summary",
        recent: "",
      },
    })
    const checkpoint = options.find((option) => option.title === "conversation-checkpoints")
    expect(checkpoint?.footer).toBe("legacy summary · 20chars")
    expect(checkpoint?.value.content).toBe("Earlier work summary")
  })

  test("registers a trusted, read-only Session command", async () => {
    const registry = new CommandRegistry<ModelContextCommandContext>()
    registry.register(modelContextCommand)
    const resolution = createHostResolver(registry.routes(), () => undefined)("/context")
    expect(resolution.status).toBe("core")
    if (resolution.status !== "core") return
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    expect(prepared.status).toBe("parsed")
    if (prepared.status !== "parsed") return

    let inspected = 0
    let presented = false
    await prepared.execute({
      source: "slash",
      client: "tui",
      sessionID: "session",
      abortSignal: new AbortController().signal,
      confirm: async () => false,
      modelContext: {
        inspect: async () => {
          inspected++
          return generation
        },
      },
      presentModelContext: async (value) => {
        presented = value === generation
      },
    })
    expect(inspected).toBe(1)
    expect(presented).toBeTrue()
  })

  test("lists system prompt parts in structured sections with summaries", () => {
    const options = modelContextOptions(generation)
    expect(options.map((option) => [option.category, option.title])).toEqual([
      ["SystemPrompt", "agent-system-prompt"],
      ["SystemPrompt", "environment"],
      ["SystemPrompt", "date"],
      ["SystemPrompt", "global-instructions"],
      ["SystemPrompt", "target-instructions"],
      ["SystemPrompt", "project-instructions"],
      ["SystemPrompt", "available_references"],
      ["SystemPrompt", "available_skills"],
      ["Messages", "conversation-checkpoints"],
      ["Tools", "read"],
      ["Tools", "grep"],
    ])
    expect(options[3]?.value.content).toBe("global rules")
    expect(options[4]?.value.content).toBe("target rules")
    expect(options[5]?.value.content).toBe("Ignored during read.")
    expect(options[5]?.footer).toBe("/workspace/project/AGENTS.md")
    expect(options[1]?.footer).toBe("mywindows linux")
    expect(options[7]?.footer).toBe("1")
    expect(options[7]?.value.content).toBe(generation.runtimeParts![4]!.text)
    expect(options[9]?.footer).toBe("Read a file from the local filesystem.")
    expect(options[9]?.inspectFooter).toBe(true)
    expect(options[9]?.value.content).toBe(
      JSON.stringify(
        {
          name: "read",
          description: "Read a file from the local filesystem.",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        null,
        2,
      ),
    )
    expect(options[10]?.value.content).toBe(
      JSON.stringify(
        {
          name: "grep",
          description: "Search file contents with a regular expression.",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
        null,
        2,
      ),
    )
  })

  test("renders emitted system parts in order with canonical titles and character-count footers", () => {
    const agentPrompt = "You are opencode, an interactive CLI tool."
    const modelIdentity = "You are powered by the model named test-model."
    const mcpText = '<mcp_instructions><server name="s">do</server></mcp_instructions>'
    const options = modelContextOptions({
      ...generation,
      systemParts: [
        { key: "agent", label: "Agent system prompt", tag: "<agent-system-prompt>", text: agentPrompt },
        { key: "model", label: "Model identity", tag: "<model>", text: modelIdentity },
        { key: "mcp", label: "MCP instructions", tag: "<mcp_instructions>", text: mcpText },
      ],
    })
    const systemParts = options.filter((option) => option.category === "SystemPrompt")
    expect(systemParts.map((option) => option.title)).toEqual(["agent-system-prompt", "model", "mcp"])
    expect(systemParts.map((option) => option.footer)).toEqual([
      `${agentPrompt.length}chars`,
      `${modelIdentity.length}chars`,
      `${mcpText.length}chars`,
    ])
    expect(systemParts[0]?.value.content).toBe(agentPrompt)
    expect(systemParts[1]?.value.content).toBe(modelIdentity)
    expect(systemParts[2]?.value.content).toBe(mcpText)
  })

  test("shows V2 target and subagent runtime parts in the system prompt section", () => {
    const options = modelContextOptions({
      ...generation,
      systemParts: null,
      runtimeParts: [
        ...(generation.runtimeParts ?? []),
        { key: "available-targets", label: "Available targets", tag: "<available-targets>", text: "target list" },
        { key: "subagents", label: "Available subagents", tag: "<available-subagents>", text: "agent list" },
      ],
    })
    expect(options.find((option) => option.title === "available-targets")?.value.content).toBe("target list")
    expect(options.find((option) => option.title === "available-subagents")?.value.content).toBe("agent list")
  })

  test("reports an empty state when no tool definitions are available", () => {
    const options = modelContextOptions({ ...generation, tools: undefined })
    const tools = options.find((option) => option.category === "Tools")
    expect(tools?.title).toBe("tool-definitions")
    expect(tools?.value.content).toBe("No tool definitions are available for this Session.")
  })

  test("announces one completed refresh state and ignores disabled or loading states", () => {
    expect(subagentRefreshToast({ status: "disabled", diagnostics: [] })).toBeUndefined()
    expect(subagentRefreshToast({ status: "loading", diagnostics: [] })).toBeUndefined()
    expect(subagentRefreshToast({ status: "ready", diagnostics: [] })).toMatchObject({
      title: "Subagent catalog ready",
      variant: "info",
    })
    expect(subagentRefreshToast({ status: "partial", diagnostics: ["Usage unavailable"] })).toMatchObject({
      title: "Subagent catalog partial",
      message: "Usage unavailable",
      variant: "warning",
    })
  })
})

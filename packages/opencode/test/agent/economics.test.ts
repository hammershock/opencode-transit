import { describe, expect, test } from "bun:test"
import { SubagentEconomics } from "@/agent/economics"

function entry(agent: string): SubagentEconomics.Entry {
  return {
    agent,
    model: { providerID: 'provider&"', modelID: "model<one>" },
    pricing: {
      status: "available",
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
      tiers: [],
      currency: "USD",
      unit: "1M_tokens",
      source: "model_catalog",
    },
    billing: { mode: "unknown" },
    benchmarks: [],
  }
}

function catalog(agents: SubagentEconomics.Entry[]): SubagentEconomics.Catalog {
  return {
    revision: "revision",
    activatedAt: "2026-09-15T00:00:00.000Z",
    status: "ready",
    agents,
    diagnostics: [],
    truncated: false,
  }
}

describe("SubagentEconomics.render", () => {
  test("sorts agents and escapes remote-controlled labels", () => {
    const result = SubagentEconomics.render(catalog([entry("zeta"), entry('alpha<"&')]))

    expect(result.truncated).toBeFalse()
    expect(result.guidance.indexOf("alpha&lt;&quot;&amp;")).toBeLessThan(result.guidance.indexOf("zeta"))
    expect(result.guidance).toContain("provider&amp;&quot;/model&lt;one&gt;")
    expect(result.guidance).not.toContain('name="alpha<')
  })

  test("bounds guidance and reports deterministic truncation", () => {
    const agents = Array.from({ length: 500 }, (_, index) =>
      entry(`${index.toString().padStart(3, "0")}-${"x".repeat(100)}`),
    )
    const first = SubagentEconomics.render(catalog(agents))
    const second = SubagentEconomics.render(catalog(agents.toReversed()))

    expect(Buffer.byteLength(first.guidance)).toBeLessThanOrEqual(16 * 1024)
    expect(first.truncated).toBeTrue()
    expect(first.guidance).toContain('truncated="true"')
    expect(second).toEqual(first)
  })
})

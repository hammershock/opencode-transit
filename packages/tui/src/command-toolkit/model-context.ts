import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type ModelContextGeneration = {
  version: 1
  generation: number
  reason: "created" | "legacy-backfill" | "location-rebound" | "init" | "instructions-applied"
  locationRevision: number
  environment: {
    harness: "OpenCode Transit"
    entrypoint: "opencode-transit"
    targetKind: "local" | "rexd"
    targetName: string
    directory: string
    projectRoot: string
    vcs?: string
    platform: string
  }
  instructions: ReadonlyArray<{
    id: string
    origin: "global-file" | "target-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
    scope: "global" | "target" | "project" | "nested"
    source: string
    declaredBy?: string
    status: "loaded" | "ignored"
    failureStage?: "discovery" | "read" | "fetch"
    content?: string
    digest?: string
  }>
  digest: string
  baseline: string
  sources: Readonly<
    Record<string, { value: unknown; baseline?: string; removed?: string; refresh?: "generation" | "activation" }>
  >
  skillCatalog?: {
    digest: string
    skills: ReadonlyArray<{ id: string; name: string; sourceLabel: string; digest: string }>
  }
  skillGuidance?: string
  subagentCatalog?: {
    revision: string
    activatedAt: string
    status: "disabled" | "loading" | "ready" | "partial" | "error"
    agents: ReadonlyArray<{
      agent: string
      model: { providerID: string; modelID: string }
      pricing: {
        status: "available" | "unavailable"
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        tiers: ReadonlyArray<{
          input: number
          output: number
          cacheRead: number
          cacheWrite: number
          context: number
        }>
        currency: "USD"
        unit: "1M_tokens"
        source: "model_catalog"
      }
      billing: {
        mode: "pay_as_you_go" | "subscription" | "token_plan" | "prepaid_credits" | "free" | "unknown"
        source?: string
      }
      benchmarks: ReadonlyArray<{
        dimension: "coding" | "research" | "general"
        benchmark: string
        value: number
        unit: string
        source: string
        observedAt: string
        datasetVersion: string
        modelVariant: string
        attribution: string
        status: "fresh" | "stale"
      }>
    }>
    diagnostics: ReadonlyArray<string>
    truncated: boolean
  }
  subagentGuidance?: string
  subagentRefresh?: {
    status: "disabled" | "loading" | "ready" | "partial" | "error"
    startedAt?: string
    completedAt?: string
    diagnostics: ReadonlyArray<string>
  }
}

export type ModelContextCommandContext = InvocationContext & {
  modelContext: {
    inspect: () => Promise<ModelContextGeneration | null>
  }
  presentModelContext: (generation: ModelContextGeneration | null) => Promise<void>
}

export function subagentRefreshToast(refresh: ModelContextGeneration["subagentRefresh"]) {
  if (!refresh || refresh.status === "disabled" || refresh.status === "loading") return
  return {
    title: `Subagent catalog ${refresh.status}`,
    message:
      refresh.diagnostics.slice(0, 3).join(" · ") ||
      (refresh.status === "ready" ? "Device-local routing guidance is ready." : "See /context for details."),
    variant: refresh.status === "ready" ? ("info" as const) : ("warning" as const),
    duration: 5000,
  }
}

const empty = (raw: RawArguments) =>
  raw.value.trim()
    ? ({
        status: "invalid",
        code: "unexpected_arguments",
        message: "This command accepts no arguments",
        range: raw.range,
      } as const)
    : ({ status: "parsed", input: undefined } as const)

export const modelContextCommand = defineCommand<void, ModelContextCommandContext>({
  id: "fork.context.inspect",
  path: ["context"],
  title: "Model context",
  description: "Inspect the frozen model context for this Session",
  category: "Session",
  provenance: { type: "core", feature: "location-model-context" },
  requires: { session: true },
  readOnly: true,
  capabilities: ["session.context.read"],
  parse: empty,
  execute: async (ctx) => {
    const generation = await ctx.modelContext.inspect()
    await ctx.presentModelContext(generation)
    return { status: "completed" }
  },
})

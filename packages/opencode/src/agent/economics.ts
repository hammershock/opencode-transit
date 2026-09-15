export * as SubagentEconomics from "./economics"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionID } from "@/session/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Agent } from "./agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SessionContextExtension } from "@opencode-ai/server/session-context-extension"
import { InstanceStore } from "@/project/instance-store"

const MAX_GUIDANCE_BYTES = 16 * 1024

export const Status = Schema.Literals(["disabled", "loading", "ready", "partial", "error"])
export type Status = typeof Status.Type

export const BillingMode = Schema.Literals([
  "pay_as_you_go",
  "subscription",
  "token_plan",
  "prepaid_credits",
  "free",
  "unknown",
])

export const Pricing = Schema.Struct({
  status: Schema.Literals(["available", "unavailable"]),
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  tiers: Schema.Array(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cacheRead: Schema.Finite,
      cacheWrite: Schema.Finite,
      context: Schema.Finite,
    }),
  ),
  currency: Schema.Literal("USD"),
  unit: Schema.Literal("1M_tokens"),
  source: Schema.Literal("model_catalog"),
})

export const Benchmark = Schema.Struct({
  dimension: Schema.Literals(["coding", "research", "general"]),
  benchmark: Schema.String,
  value: Schema.Finite,
  unit: Schema.String,
  source: Schema.String,
  observedAt: Schema.String,
  datasetVersion: Schema.String,
  modelVariant: Schema.String,
  attribution: Schema.String,
  status: Schema.Literals(["fresh", "stale"]),
})

export const Entry = Schema.Struct({
  agent: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  pricing: Pricing,
  billing: Schema.Struct({ mode: BillingMode, source: Schema.optional(Schema.String) }),
  benchmarks: Schema.Array(Benchmark),
})
export type Entry = typeof Entry.Type

export const Catalog = Schema.Struct({
  revision: Schema.String,
  activatedAt: Schema.String,
  status: Status,
  agents: Schema.Array(Entry),
  diagnostics: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})
export type Catalog = typeof Catalog.Type

export interface Interface {
  readonly guidance: (sessionID: SessionID, parent: Agent.Info) => Effect.Effect<string | undefined>
  readonly peek: (sessionID: SessionID) => Effect.Effect<Catalog | undefined>
  readonly invalidate: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentEconomics") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const catalogs = new Map<SessionID, { catalog: Catalog; guidance: string }>()

    const load = Effect.fn("SubagentEconomics.load")(function* (sessionID: SessionID, parent: Agent.Info) {
      const cached = catalogs.get(sessionID)
      if (cached) return cached
      if ((yield* config.get()).experimental?.subagent_economics !== true) return undefined

      const entries = yield* Effect.forEach(
        (yield* agents.list())
          .filter(
            (item): item is Agent.Info & { model: NonNullable<Agent.Info["model"]> } =>
              item.mode !== "primary" &&
              item.hidden !== true &&
              item.model !== undefined &&
              Permission.evaluate("task", item.name, parent.permission).action !== "deny",
          )
          .toSorted((a, b) => a.name.localeCompare(b.name)),
        (item) =>
          provider.getModel(item.model.providerID, item.model.modelID).pipe(
            Effect.map((model) =>
              Entry.make({
                agent: item.name,
                model: item.model,
                pricing: {
                  status:
                    model.cost.input !== 0 ||
                    model.cost.output !== 0 ||
                    model.cost.cache.read !== 0 ||
                    model.cost.cache.write !== 0 ||
                    (model.cost.tiers?.length ?? 0) > 0
                      ? "available"
                      : "unavailable",
                  input: model.cost.input,
                  output: model.cost.output,
                  cacheRead: model.cost.cache.read,
                  cacheWrite: model.cost.cache.write,
                  tiers: (model.cost.tiers ?? []).map((tier) => ({
                    input: tier.input,
                    output: tier.output,
                    cacheRead: tier.cache.read,
                    cacheWrite: tier.cache.write,
                    context: tier.tier.size,
                  })),
                  currency: "USD",
                  unit: "1M_tokens",
                  source: "model_catalog",
                },
                billing: { mode: "unknown" },
                benchmarks: [],
              }),
            ),
            Effect.option,
          ),
        { concurrency: 8 },
      )
      const resolved = entries.flatMap((entry) => (entry._tag === "Some" ? [entry.value] : []))
      const activatedAt = (yield* DateTime.nowAsDate).toISOString()
      const base = Catalog.make({
        revision: Hash.sha256(JSON.stringify(resolved)),
        activatedAt,
        status: resolved.length === entries.length ? "ready" : "partial",
        agents: resolved,
        diagnostics:
          resolved.length === entries.length ? [] : ["One or more configured subagent models are unavailable"],
        truncated: false,
      })
      const rendered = render(base)
      const value = {
        catalog: rendered.truncated ? Catalog.make({ ...base, truncated: true }) : base,
        guidance: rendered.guidance,
      }
      catalogs.set(sessionID, value)
      return value
    })

    return Service.of({
      guidance: Effect.fn("SubagentEconomics.guidance")(function* (sessionID, parent) {
        return (yield* load(sessionID, parent))?.guidance
      }),
      peek: Effect.fn("SubagentEconomics.peek")(function* (sessionID) {
        return catalogs.get(sessionID)?.catalog
      }),
      invalidate: Effect.fn("SubagentEconomics.invalidate")(function* (sessionID) {
        catalogs.delete(sessionID)
      }),
    })
  }),
)

export function render(catalog: Catalog) {
  const header = [
    "The declaration below is the authoritative device-local subagent economics catalog for this Session activation.",
    "Use it as advisory evidence when selecting a subagent. Missing values are unknown; list prices are not actual billed cost.",
  ].join("\n")
  const open = `<available_subagents status="${catalog.status}" refreshed_at="${escape(catalog.activatedAt)}">`
  const close = "</available_subagents>"
  const rows = catalog.agents
    .toSorted((a, b) => a.agent.localeCompare(b.agent))
    .map((entry) => {
      const tiers = entry.pricing.tiers
        .map(
          (tier) =>
            `<tier context="${tier.context}" input="${tier.input}" output="${tier.output}" cache_read="${tier.cacheRead}" cache_write="${tier.cacheWrite}" />`,
        )
        .join("")
      const pricing =
        entry.pricing.status === "available"
          ? `<pricing status="available" input="${entry.pricing.input}" output="${entry.pricing.output}" cache_read="${entry.pricing.cacheRead}" cache_write="${entry.pricing.cacheWrite}" currency="USD" unit="1M_tokens" source="model_catalog">${tiers}</pricing>`
          : '<pricing status="unavailable" />'
      return `<subagent name="${escape(entry.agent)}" model="${escape(`${entry.model.providerID}/${entry.model.modelID}`)}" billing="${entry.billing.mode}">${pricing}</subagent>`
    })
  const selected: string[] = []
  for (const row of rows) {
    const candidate = [header, open, ...selected, row, close].join("\n")
    if (Buffer.byteLength(candidate) > MAX_GUIDANCE_BYTES) break
    selected.push(row)
  }
  const truncated = selected.length !== rows.length
  const start = truncated ? open.replace(">", ' truncated="true">') : open
  return { guidance: [header, start, ...selected, close].join("\n"), truncated }
}

const contextLayer = Layer.effect(
  SessionContextExtension.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const economics = yield* Service
    const instances = yield* InstanceStore.Service

    const inspect = Effect.fn("SubagentEconomics.inspect")(function* (sessionID: SessionID) {
      if ((yield* config.get()).experimental?.subagent_economics !== true) {
        return {
          subagentCatalog: null,
          subagentGuidance: null,
          subagentRefresh: { status: "disabled" as const, diagnostics: [] },
        }
      }
      const catalog = yield* economics.peek(sessionID)
      if (!catalog) {
        return {
          subagentCatalog: null,
          subagentGuidance: null,
          subagentRefresh: { status: "loading" as const, diagnostics: [] },
        }
      }
      return {
        subagentCatalog: catalog,
        subagentGuidance: render(catalog).guidance,
        subagentRefresh: {
          status: catalog.status,
          completedAt: catalog.activatedAt,
          diagnostics: catalog.diagnostics,
        },
      }
    })

    return SessionContextExtension.Service.of({
      activate: Effect.fn("SubagentEconomics.activateContext")(function* (input) {
        return yield* instances.provide(
          { directory: input.directory },
          Effect.gen(function* () {
            const parent = input.agent ? yield* agents.get(input.agent) : yield* agents.defaultInfo()
            yield* economics.guidance(input.sessionID, parent)
            return yield* inspect(input.sessionID)
          }),
        )
      }),
      inspect: Effect.fn("SubagentEconomics.inspectContext")((input) =>
        instances.provide({ directory: input.directory }, inspect(input.sessionID)),
      ),
    })
  }),
)

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, Agent.node, Provider.node] })
export const contextNode = LayerNode.make({
  service: SessionContextExtension.Service,
  layer: contextLayer,
  deps: [node, Config.node, Agent.node, InstanceStore.node],
})

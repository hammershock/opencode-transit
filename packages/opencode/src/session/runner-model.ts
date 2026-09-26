export * as OpenCodeSessionRunnerModel from "./runner-model"

import { Auth } from "@/auth"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Provider } from "@/provider/provider"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Project } from "@/project/project"
import { Effect, Layer } from "effect"

const supportedLegacyApis = new Set(["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible"])

const layer = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const legacy = yield* Provider.Service
    const projects = yield* Project.Service

    return SessionRunnerModel.Service.of({
      resolve: Effect.fn("OpenCode.SessionRunnerModel.resolve")(function* (session) {
        const available = yield* catalog.model.available()
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? available.find((model) => model.providerID === session.model?.providerID && model.id === session.model.id)
          : defaultModel && SessionRunnerModel.supported(defaultModel)
            ? defaultModel
            : available.find(SessionRunnerModel.supported)

        if (selected) {
          const provider = yield* catalog.provider.get(selected.providerID)
          const connection = yield* integrations.connection.active(
            provider?.integrationID ?? Integration.ID.make(selected.providerID),
          )
          const credential = connection
            ? yield* integrations.connection.resolve(connection)
            : yield* auth.get(selected.providerID).pipe(
                Effect.map(legacyCredential),
                Effect.catch(() => Effect.succeed(undefined)),
              )
          return yield* SessionRunnerModel.resolve(session, selected, credential)
        }

        if (!session.model) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        const reference = session.model
        const model = yield* catalog.model.get(session.model.providerID, session.model.id)
        const provider = yield* catalog.provider.get(session.model.providerID)
        const credential = yield* auth.get(session.model.providerID).pipe(
          Effect.map(legacyCredential),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (model && (!model.enabled || provider?.disabled))
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (model?.enabled && !provider?.disabled && credential)
          return yield* SessionRunnerModel.resolve(session, model, credential)
        const project = yield* projects.get(session.projectID)
        if (!project)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        // Session drains are process-global; the caller's request fiber may no longer exist.
        const instance = {
          directory: session.location.directory,
          worktree: project.worktree,
          project,
          target: session.location.target,
          ...(session.location.workspaceID ? { workspaceID: session.location.workspaceID } : {}),
        }
        const configured = yield* Effect.gen(function* () {
          const model = yield* legacy
            .getModel(reference.providerID, reference.id)
            .pipe(Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)))
          return {
            model,
            provider: model ? yield* legacy.getProvider(reference.providerID) : undefined,
          }
        }).pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.provideService(WorkspaceRef, session.location.workspaceID),
        )
        if (configured.model && !supportedLegacyApis.has(configured.model.api.npm))
          return yield* new SessionRunnerModel.UnsupportedApiError({
            providerID: session.model.providerID,
            modelID: session.model.id,
            api: configured.model.api.npm,
          })
        const bridged =
          configured.model && configured.provider
            ? legacyModel(configured.model, configured.provider, credential)
            : undefined
        if (!bridged)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        return yield* SessionRunnerModel.resolve(session, bridged, credential)
      }),
    })
  }),
)

export function legacyModel(model: Provider.Model, provider: Provider.Info, credential?: Credential.Value) {
  if (!supportedLegacyApis.has(model.api.npm)) return
  const key = provider.key ?? (typeof provider.options.apiKey === "string" ? provider.options.apiKey : undefined)
  if (!credential && !key) return
  return ModelV2.Info.make({
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    ...(model.family ? { family: ModelV2.Family.make(model.family) } : {}),
    api: {
      id: ModelV2.ID.make(model.api.id),
      type: "aisdk",
      package: model.api.npm,
      url: typeof provider.options.baseURL === "string" ? provider.options.baseURL : model.api.url,
      settings: {},
    },
    capabilities: {
      tools: model.capabilities.toolcall,
      input: Object.entries(model.capabilities.input)
        .filter(([, enabled]) => enabled)
        .map(([kind]) => kind),
      output: Object.entries(model.capabilities.output)
        .filter(([, enabled]) => enabled)
        .map(([kind]) => kind),
    },
    request: {
      headers: model.headers,
      body: { ...model.options, ...(!credential && key ? { apiKey: key } : {}) },
    },
    variants: Object.entries(model.variants ?? {}).map(([id, body]) => ({
      id: ModelV2.VariantID.make(id),
      headers: {},
      body,
    })),
    time: { released: Date.parse(model.release_date) || 0 },
    cost: [
      { input: model.cost.input, output: model.cost.output, cache: model.cost.cache },
      ...(model.cost.tiers ?? []).map((tier) => ({
        input: tier.input,
        output: tier.output,
        cache: tier.cache,
        tier: { type: "context" as const, size: Math.trunc(tier.tier.size) },
      })),
    ],
    status: model.status,
    enabled: true,
    limit: {
      context: Math.trunc(model.limit.context),
      ...(model.limit.input === undefined ? {} : { input: Math.trunc(model.limit.input) }),
      output: Math.trunc(model.limit.output),
    },
  })
}

export function legacyCredential(info: Auth.Info | undefined): Credential.Value | undefined {
  if (info?.type === "api") return Credential.Key.make({ type: "key", key: info.key, metadata: info.metadata })
  if (info?.type === "oauth")
    return Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("legacy"),
      refresh: info.refresh,
      access: info.access,
      expires: info.expires,
      metadata: {
        ...(info.accountId === undefined ? {} : { accountId: info.accountId }),
        ...(info.enterpriseUrl === undefined ? {} : { enterpriseUrl: info.enterpriseUrl }),
      },
    })
}

export const node = makeLocationNode({
  service: SessionRunnerModel.Service,
  layer,
  deps: [Auth.node, Catalog.node, Integration.node, Provider.node, Project.node],
})

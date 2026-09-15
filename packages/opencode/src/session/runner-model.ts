export * as OpenCodeSessionRunnerModel from "./runner-model"

import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ConfigProviderOptionsV1 } from "@opencode-ai/core/v1/config/provider-options"
import { Effect, Layer, Schema } from "effect"

const layer = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const legacyProvider = yield* Provider.Service

    const withLegacyVariant = Effect.fnUntraced(function* (model: ModelV2.Info, variant: string | undefined) {
      if (!variant || variant === "default" || model.variants.some((item) => item.id === variant)) return model
      const legacy = yield* legacyProvider
        .getModel(model.providerID, model.id)
        .pipe(Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)))
      const resolved = legacy && legacyVariants(legacy).find((item) => item.id === variant)
      if (!resolved) return model
      return { ...model, variants: [...model.variants, resolved] }
    })

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
          return yield* SessionRunnerModel.resolve(
            session,
            yield* withLegacyVariant(selected, session.model?.variant),
            connection ? yield* integrations.connection.resolve(connection) : undefined,
          )
        }

        if (!session.model) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        const model = yield* catalog.model.get(session.model.providerID, session.model.id)
        const provider = yield* catalog.provider.get(session.model.providerID)
        const credential = yield* auth.get(session.model.providerID).pipe(
          Effect.map(legacyCredential),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!model?.enabled || provider?.disabled || !credential)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        return yield* SessionRunnerModel.resolve(
          session,
          yield* withLegacyVariant(model, session.model.variant),
          credential,
        )
      }),
    })
  }),
)

export function legacyVariants(model: {
  readonly api: { readonly npm: string }
  readonly variants?: Provider.Model["variants"]
}) {
  const lower = ConfigProviderOptionsV1.get(model.api.npm).request
  const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
  return Object.entries(model.variants ?? {}).map(([id, options]) => ({
    id: ModelV2.VariantID.make(id),
    headers: {},
    body: decode(lower(options)),
  }))
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
  deps: [Auth.node, Catalog.node, Integration.node, Provider.node],
})

import { describe, expect, test } from "bun:test"
import { Node } from "@opencode-ai/core/effect/app-node"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Auth } from "../../src/auth"
import { OpenCodeSessionRunnerModel } from "../../src/session/runner-model"
import { Provider } from "../../src/provider/provider"

describe("SessionRunnerModel compatibility", () => {
  test("preserves location and controller-global dependency scopes", () => {
    expect(OpenCodeSessionRunnerModel.node.tag).toBe(SessionRunnerModel.node.tag)
    expect(Auth.node.tag).toBe(Node.tags.values.global)
  })

  test("adapts legacy API credentials without persisting a new credential", () => {
    expect(
      OpenCodeSessionRunnerModel.legacyCredential(
        new Auth.Api({ type: "api", key: "secret", metadata: { tenant: "work" } }),
      ),
    ).toEqual({ type: "key", key: "secret", metadata: { tenant: "work" } })
  })

  test("adapts legacy OAuth credentials in memory", () => {
    const credential = OpenCodeSessionRunnerModel.legacyCredential(
      new Auth.Oauth({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: 123,
        accountId: "account",
      }),
    )

    expect(credential?.type).toBe("oauth")
    if (credential?.type !== "oauth") return
    expect(String(credential.methodID)).toBe("legacy")
    expect(credential.refresh).toBe("refresh")
    expect(credential.access).toBe("access")
    expect(credential.expires).toBe(123)
    expect(credential.metadata).toEqual({ accountId: "account" })
  })

  test("does not treat well-known configuration tokens as model credentials", () => {
    expect(
      OpenCodeSessionRunnerModel.legacyCredential(
        new Auth.WellKnown({ type: "wellknown", key: "TOKEN", token: "value" }),
      ),
    ).toBeUndefined()
  })

  test("bridges a configured OpenAI-compatible model without exposing its key in request body", () => {
    const model: Provider.Model = {
      id: ModelV2.ID.make("deepseek-flash"),
      providerID: ProviderV2.ID.make("deepseek"),
      api: { id: "deepseek-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
      name: "DeepSeek Flash",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: { "x-test": "route" },
      release_date: "2026-01-01",
      variants: { quick: { temperature: 0.2 } },
    }
    const provider: Provider.Info = {
      id: model.providerID,
      name: "DeepSeek",
      source: "api",
      env: [],
      key: "provider-secret",
      options: {},
      models: { [model.id]: model },
    }
    const credential = OpenCodeSessionRunnerModel.legacyCredential(new Auth.Api({ type: "api", key: "auth-secret" }))
    const bridged = OpenCodeSessionRunnerModel.legacyModel(model, provider, credential)
    expect(bridged?.api).toMatchObject({
      type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.deepseek.com",
    })
    expect(bridged?.request).toEqual({ headers: { "x-test": "route" }, body: {} })
    expect(bridged?.capabilities.tools).toBe(true)
    expect(bridged?.variants[0]).toMatchObject({ id: "quick", body: { temperature: 0.2 } })
    expect(bridged?.limit).toEqual({ context: 128000, output: 8192 })
    expect(OpenCodeSessionRunnerModel.legacyModel(model, provider)?.request.body).toEqual({ apiKey: "provider-secret" })
    expect(
      OpenCodeSessionRunnerModel.legacyModel(model, {
        ...provider,
        key: undefined,
        options: { apiKey: "configured-secret", baseURL: "http://127.0.0.1:1234" },
      }),
    ).toMatchObject({
      api: { url: "http://127.0.0.1:1234" },
      request: { body: { apiKey: "configured-secret" } },
    })
    expect(OpenCodeSessionRunnerModel.legacyModel(model, { ...provider, key: undefined })).toBeUndefined()
    expect(OpenCodeSessionRunnerModel.legacyModel({ ...model, api: { ...model.api, npm: "@ai-sdk/google" } }, provider, credential)).toBeUndefined()
  })
})

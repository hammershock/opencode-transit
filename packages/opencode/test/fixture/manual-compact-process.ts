import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { SessionV2 } from "@opencode-ai/core/session"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { Context } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { eq } from "drizzle-orm"

const directory = process.env.MANUAL_COMPACT_TEST_DIRECTORY
const llmURL = process.env.MANUAL_COMPACT_TEST_LLM_URL
if (!directory || !llmURL) throw new Error("Missing manual compaction fixture configuration")
const http = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
const result = await AppRuntime.runPromise(
  Effect.scoped(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory },
        Effect.gen(function* () {
          const model = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") }
          const session = yield* SessionV2.Service
          const info = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
            approvalMode: "auto",
            agent: AgentV2.ID.make("build"),
            model,
          })
          const locations = yield* LocationServiceMap.Service
          yield* Catalog.Service.use((catalog) =>
            catalog.transform((draft) => {
              draft.provider.update(model.providerID, (provider) => {
                provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llmURL, settings: {} }
                provider.request.body.apiKey = "test-key"
              })
              draft.model.update(model.providerID, model.id, () => {})
            }),
          ).pipe(Effect.provide(locations.get(info.location)))
          if (process.env.MANUAL_COMPACT_TEST_EMPTY !== "true") {
            yield* session.prompt({ sessionID: info.id, prompt: { text: "Initial question" }, resume: false })
            yield* session.resume(info.id)
          }
          const before = yield* session.context(info.id)
          const legacy = process.env.MANUAL_COMPACT_TEST_LEGACY === "true"
          const response = yield* Effect.promise(() =>
            http.handler(
              new Request(
                legacy
                  ? `http://localhost/session/${info.id}/summarize`
                  : `http://localhost/api/session/${info.id}/compact`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-opencode-directory": directory },
                  ...(legacy ? { body: JSON.stringify({ providerID: "test", modelID: "test-model" }) } : {}),
                },
              ),
              Context.empty() as Context.Context<unknown>,
            ),
          )
          const body = yield* Effect.promise(() => response.text())
          const db = (yield* Database.Service).db
          return {
            status: response.status,
            body,
            before,
            context: yield* session.context(info.id),
            legacyMessages: (yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, info.id)).all())
              .length,
            model: (yield* session.get(info.id)).model,
          }
        }),
      ),
    ),
  ),
)
process.stdout.write(`MANUAL_COMPACT_RESULT:${JSON.stringify(result)}\n`)
await http.dispose()
await AppRuntime.dispose()

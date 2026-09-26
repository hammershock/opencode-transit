import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionMessageTable, SessionPeerRouteTable, SessionTaskResultTable, SessionTaskTable, SessionTable } from "@opencode-ai/core/session/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { Effect, Duration } from "effect"
import { Context } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { Server } from "@/server/server"
import { eq } from "drizzle-orm"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"

const directory = process.env.TASK_V2_TEST_DIRECTORY
const llmURL = process.env.TASK_V2_TEST_LLM_URL
if (!directory || !llmURL) throw new Error("Missing Task V2 parent fixture configuration")
const http = process.env.TASK_V2_TEST_HTTP === "true"
  ? HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
  : undefined
if (process.env.TASK_V2_TEST_DEFAULT_HANDLER_FIRST === "true") {
  const response = await Server.Default().app.request("/global/health")
  if (!response.ok) throw new Error(`Default HTTP handler failed: ${response.status}`)
}

const outcome = await AppRuntime.runPromise(
  InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      Effect.gen(function* () {
        const model = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") }
        const session = yield* SessionV2.Service
        const parent = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          approvalMode: "auto",
          agent: AgentV2.ID.make("build"),
          model,
          permission: process.env.TASK_V2_TEST_DENIED === "true" ? [] : [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const db = (yield* Database.Service).db
        if (process.env.TASK_V2_TEST_DENIED === "true")
          yield* db.update(SessionTable).set({ subagent_access: { build: { general: false } } }).where(eq(SessionTable.id, parent.id))
        const locations = yield* LocationServiceMap.Service
        const location = yield* (yield* SessionLocationAccess.Service).require(parent.id)
        yield* Catalog.Service.use((catalog) =>
          catalog.transform((draft) => {
            draft.provider.update(model.providerID, (provider) => {
              provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llmURL, settings: {} }
              provider.request.body.apiKey = "test-key"
            })
            draft.model.update(model.providerID, model.id, () => {})
          }),
        ).pipe(Effect.provide(locations.get(location)))
        const text = process.env.TASK_V2_TEST_CONTROL === "status" ? "PARENT_STATUS_MARKER"
          : process.env.TASK_V2_TEST_CONTROL === "wait-invalid" ? "PARENT_WAIT_INVALID_MARKER"
          : "PARENT_TASK_MARKER"
        const admitted = process.env.TASK_V2_TEST_COMMAND === "true" && http
          ? yield* Effect.promise(async () => {
              const response = await http.handler(
                new Request(`http://localhost/session/${parent.id}/command`, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-opencode-directory": directory },
                  body: JSON.stringify({ command: "inspect", arguments: "cache", model: "test/test-model" }),
                }),
                Context.empty() as Context.Context<unknown>,
              )
              const body = await response.json() as { info?: { id: string } }
              if (response.status !== 200 || !body.info) throw new Error(`HTTP command failed: ${response.status} ${JSON.stringify(body)}`)
              return { id: SessionMessage.ID.make(body.info.id) }
            })
          : http
          ? yield* Effect.promise(async () => {
              const response = await http.handler(
                new Request(`http://localhost/api/session/${parent.id}/prompt`, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-opencode-directory": directory },
                  body: JSON.stringify({ prompt: { text } }),
                }),
                Context.empty() as Context.Context<unknown>,
              )
              const body = await response.json() as { data?: { id: string } }
              if (response.status !== 200 || !body.data) throw new Error(`HTTP V2 prompt failed: ${response.status} ${JSON.stringify(body)}`)
              return { id: SessionMessage.ID.make(body.data.id) }
            })
          : yield* session.prompt({ sessionID: parent.id, prompt: { text } })
        if (process.env.TASK_V2_TEST_CONTROL === "status" || process.env.TASK_V2_TEST_CONTROL === "wait-invalid" || process.env.TASK_V2_TEST_DENIED === "true") {
          for (let attempt = 0; attempt < 240; attempt++) {
            if (yield* SessionInput.isSettled(db, parent.id, admitted.id))
              return {
                parent: parent.id,
                rows: [],
                legacyMessages: (yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, parent.id)).all()).length,
                messages: yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, parent.id)).all(),
                routeCount: process.env.TASK_V2_TEST_DENIED === "true"
                  ? (yield* db.select().from(SessionPeerRouteTable).all()).length
                  : undefined,
                sessionCount: process.env.TASK_V2_TEST_DENIED === "true"
                  ? (yield* db.select().from(SessionTable).all()).length
                  : undefined,
                activity: process.env.TASK_V2_TEST_ACTIVITY === "true" && http
                  ? yield* Effect.promise(async () => {
                      const response = await http.handler(
                        new Request(`http://localhost/api/session/${parent.id}/activity?after=-1&limit=500`, {
                          headers: { "x-opencode-directory": directory },
                        }),
                        Context.empty() as Context.Context<unknown>,
                      )
                      const body = await response.json()
                      if (response.status !== 200) throw new Error(`HTTP activity failed: ${response.status} ${JSON.stringify(body)}`)
                      return body
                    })
                  : undefined,
              }
            yield* Effect.sleep(Duration.millis(50))
          }
          return yield* Effect.die("V2 parent control call never settled")
        }
        for (let attempt = 0; attempt < (process.env.TASK_V2_TEST_SETTLE === "true" ? 1200 : 240); attempt++) {
          const rows = yield* db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.parent_session_id, parent.id))
            .all()
          if (rows.length > 0 && (process.env.TASK_V2_TEST_SETTLE !== "true" || rows.every((row) => row.state === "settled")))
            return {
              parent: parent.id,
              control: process.env.TASK_V2_TEST_STATUS === "true" && http
                ? yield* Effect.promise(async () => {
                    const row = rows[0]!
                    const request = async (route: string, body: unknown) => {
                      const response = await http.handler(
                        new Request(`http://localhost/api/session/${parent.id}/task/${route}`, {
                          method: "POST",
                          headers: { "content-type": "application/json", "x-opencode-directory": directory },
                          body: JSON.stringify(body),
                        }),
                        Context.empty() as Context.Context<unknown>,
                      )
                      const payload = await response.json()
                      if (response.status !== 200) throw new Error(`${route}: ${response.status} ${JSON.stringify(payload)}`)
                      return payload
                    }
                    return {
                      status: await request("status", { target: { task_id: row.child_session_id } }),
                      interrupt: await request("interrupt", {
                        target: {
                          task_id: row.child_session_id,
                          input_id: row.input_id,
                          invocation: {
                            parent_session_id: row.parent_session_id,
                            parent_message_id: row.parent_message_id,
                            call_id: row.call_id,
                          },
                        },
                      }),
                    }
                  })
                : undefined,
              rows: yield* Effect.forEach(rows, (row) =>
                Effect.gen(function* () {
                  const session = yield* db.select({ target: SessionTable.target, directory: SessionTable.directory })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, SessionSchema.ID.make(row.child_session_id)))
                    .get()
                  const result = yield* db.select({ summary: SessionTaskResultTable.summary })
                    .from(SessionTaskResultTable)
                    .where(eq(SessionTaskResultTable.invocation_input_id, row.input_id))
                    .get()
                  const events = yield* db.select({ type: EventTable.type, data: EventTable.data })
                    .from(EventTable)
                    .where(eq(EventTable.aggregate_id, row.child_session_id))
                    .all()
                  return {
                    child: row.child_session_id,
                    backend: row.backend,
                    state: row.state,
                    outcome: row.outcome,
                    summary: result?.summary,
                    events: events.map((event) => ({ type: event.type, data: event.type.includes("failed") ? event.data : undefined })),
                    target: session?.target,
                    directory: session?.directory,
                  }
                }),
              ),
              legacyMessages: (yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, parent.id)).all()).length,
              contextParts: (yield* session.requestContext(parent.id)).runtimeParts
                .filter((part) => part.key === "subagents" || part.key === "available-targets")
                .map((part) => ({ key: part.key, text: part.text })),
            }
          yield* Effect.sleep(Duration.millis(50))
        }
        const messages = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, parent.id)).all()
        return yield* Effect.die(`V2 parent provider never admitted Task: ${JSON.stringify(messages)}`)
      }).pipe(Effect.scoped),
    ),
  ),
)

console.log(`TASK_V2_PARENT_RESULT:${JSON.stringify(outcome)}`)
await http?.dispose()
if (process.env.TASK_V2_TEST_DEFAULT_HANDLER_FIRST === "true") await HttpApiApp.webHandler().dispose()
await AppRuntime.dispose()

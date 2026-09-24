import { Context, Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

const directory = process.env.PROMPT_BACKEND_TEST_DIRECTORY
if (!directory || !process.env.OPENCODE_DB || process.env.OPENCODE_DB === ":memory:")
  throw new Error("Prompt backend fixture requires an isolated file database")
const handler = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
const request = (pathname: string, method = "GET", body?: unknown) =>
  handler.handler(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    Context.empty() as Context.Context<unknown>,
  )
const created = await request("/api/session", "POST", {})
if (created.status !== 200) throw new Error(`Session creation failed: ${created.status}`)
const sessionID = ((await created.json()) as { data: { id: string } }).data.id
const route = `/api/session/${sessionID}/prompt/backend`
const empty = await request(route)
const promptSession = await request("/api/session", "POST", {})
if (promptSession.status !== 200) throw new Error(`Prompt Session creation failed: ${promptSession.status}`)
const promptSessionID = ((await promptSession.json()) as { data: { id: string } }).data.id
const emptyPrompt = await request(`/api/session/${promptSessionID}/prompt`, "POST", { prompt: { text: "baseline" }, resume: false })
await AppRuntime.runPromise(
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const instance = yield* instances.load({ directory })
    return yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(MessageTable).values({
        id: "msg_legacy_assistant" as typeof MessageTable.$inferInsert.id,
        session_id: SessionSchema.ID.make(sessionID),
        data: { role: "assistant" } as typeof MessageTable.$inferInsert.data,
      })
    }).pipe(Effect.provideService(InstanceRef, instance))
  }),
)
const legacy = await request(route)
const blocked = await request(`/api/session/${sessionID}/prompt`, "POST", { prompt: { text: "must stay legacy" } })
const blockedSkill = await request(`/api/session/${sessionID}/prompt`, "POST", {
  prompt: {
    text: "use skill",
    skills: [{ id: `skl_${"0".repeat(64)}`, name: "missing", source: { start: 0, end: 9, text: "use skill" } }],
  },
})
process.stdout.write(
  `PROMPT_BACKEND_HTTP:${JSON.stringify({
    empty: { status: empty.status, body: await empty.json() },
    emptyPrompt: { status: emptyPrompt.status, body: await emptyPrompt.json() },
    legacy: { status: legacy.status, body: await legacy.json() },
    blocked: { status: blocked.status, body: await blocked.json() },
    blockedSkill: { status: blockedSkill.status, body: await blockedSkill.json() },
  })}\n`,
)
await handler.dispose()
await AppRuntime.dispose()

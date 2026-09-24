import { Cause, Context, Effect, Exit } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { existsSync } from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { eq } from "drizzle-orm"

const directory = process.env.PROMPT_RACE_DIRECTORY
const mode = process.env.PROMPT_RACE_MODE
const sessionID = process.env.PROMPT_RACE_SESSION
if (!directory || !mode || !process.env.OPENCODE_DB || process.env.OPENCODE_DB === ":memory:")
  throw new Error("Prompt race fixture requires a shared file database")
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

if (mode === "create") {
  const response = await request("/api/session", "POST", {})
  process.stdout.write(`PROMPT_RACE:${JSON.stringify({ status: response.status, body: await response.json() })}\n`)
}
if (mode === "v1" || mode === "v2") {
  if (!sessionID) throw new Error("Missing Session ID")
  await AppRuntime.runPromise(Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const instance = yield* instances.load({ directory })
    return yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, SessionSchema.ID.make(sessionID))).limit(1).get()
    }).pipe(Effect.provideService(InstanceRef, instance))
  }))
  const ready = `${directory}/prompt-race-${mode}.ready`
  const start = `${directory}/prompt-race.start`
  await Bun.write(ready, "ready")
  for (let attempt = 0; !existsSync(start); attempt++) {
    if (attempt >= 400) throw new Error("Prompt race barrier timed out")
    await Bun.sleep(10)
  }
  if (mode === "v1") {
    const response = await request(`/session/${sessionID}/message`, "POST", {
        noReply: true,
        parts: [{ type: "text", text: "legacy first input" }],
      })
    process.stdout.write(`PROMPT_RACE:${JSON.stringify({ mode, status: response.status, body: await response.text() })}\n`)
  } else {
    const exit = await AppRuntime.runPromiseExit(
      Effect.gen(function* () {
        const instances = yield* InstanceStore.Service
        const instance = yield* instances.load({ directory })
        return yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const events = yield* EventV2Bridge.Service
          return yield* SessionInput.admit(db, events, {
            id: SessionMessage.ID.create(),
            sessionID: SessionSchema.ID.make(sessionID),
            prompt: Prompt.make({ text: "canonical first input" }),
            delivery: "steer",
          })
        }).pipe(Effect.provideService(InstanceRef, instance))
      }),
    )
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    process.stdout.write(`PROMPT_RACE:${JSON.stringify({ mode, status: Exit.isSuccess(exit) ? 200 : failure instanceof SessionInput.PromptBackendConflict ? 409 : 500, failure: failure?.constructor.name, detail: failure instanceof Error ? failure.message : String(failure) })}\n`)
  }
}
if (mode === "inspect") {
  if (!sessionID) throw new Error("Missing Session ID")
  const rows = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      const instance = yield* instances.load({ directory })
      return yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const v1 = yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.session_id, SessionSchema.ID.make(sessionID))).all()
        const v2 = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(eq(SessionInputTable.session_id, SessionSchema.ID.make(sessionID))).all()
        return { v1: v1.length, v2: v2.length }
      }).pipe(Effect.provideService(InstanceRef, instance))
    }),
  )
  process.stdout.write(`PROMPT_RACE:${JSON.stringify(rows)}\n`)
}
await handler.dispose()
await AppRuntime.dispose()

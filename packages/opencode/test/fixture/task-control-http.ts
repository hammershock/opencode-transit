import { Context, Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

const directory = process.env.TASK_CONTROL_HTTP_DIRECTORY
if (!directory) throw new Error("TASK_CONTROL_HTTP_DIRECTORY is required")
if (!process.env.OPENCODE_DB || process.env.OPENCODE_DB === ":memory:")
  throw new Error("HTTP control fixture requires a file database")
const handler = HttpRouter.toWebHandler(
  HttpApiApp.createRoutes(undefined, {
    id: "session_v2",
    features: new Set<SessionTaskCapability.Feature>([
      "atomic_admission",
      "exact_owner_guard",
      "durable_queue",
      "reconcile",
      "exact_cancellation",
      "exact_result",
      "notification",
    ]),
  }),
  { disableLogger: true },
)
const request = async (route: string, body: unknown) => {
  const response = await handler.handler(
    new Request(`http://localhost${route}`, {
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
const parent = (await request("/api/session", {})) as { data: { id: string } }
const child = await AppRuntime.runPromise(
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const instance = yield* instances.load({ directory })
    return yield* Effect.gen(function* () {
      const session = yield* SessionV2.Service
      return yield* session.create({
        parentID: SessionSchema.ID.make(parent.data.id),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
    }).pipe(Effect.provideService(InstanceRef, instance))
  }),
)
const first = SessionMessage.ID.create()
const later = SessionMessage.ID.create()
const admit = (inputID: string, callID: string) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      const instance = yield* instances.load({ directory })
      return yield* Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* SessionTask.withOwner(child.id)(
          database.db.transaction(
            () =>
              SessionTask.admit(database.db, {
                inputID,
                rootSessionID: SessionSchema.ID.make(parent.data.id),
                parentSessionID: SessionSchema.ID.make(parent.data.id),
                parentMessageID: "msg-http-parent",
                callID,
                promptDigest: callID,
                childSessionID: child.id,
                description: "HTTP control fixture",
                agentID: "build",
                locationRevision: 0,
                backend: "v2",
              }),
            { behavior: "immediate" },
          ),
        )
      }).pipe(Effect.provideService(InstanceRef, instance))
    }),
  )
if ((await admit(first, "call-first"))?.state !== "admitted") throw new Error("First input was not admitted")
const payload = { task_id: child.id, operation_id: "http-stop-once" }
const stopped = await request(`/api/session/${parent.data.id}/task/stop`, payload)
if ((await admit(later, "call-later"))?.state !== "admitted") throw new Error("Later input was not admitted")
const retry = await request(`/api/session/${parent.data.id}/task/stop`, payload)
const interrupted = await request(`/api/session/${parent.data.id}/task/interrupt`, {
  target: {
    task_id: child.id,
    input_id: later,
    invocation: { parent_session_id: parent.data.id, parent_message_id: "msg-http-parent", call_id: "call-later" },
  },
})
process.stdout.write(`TASK_CONTROL_HTTP:${JSON.stringify({ first, later, stopped, retry, interrupted })}\n`)
await handler.dispose()
await AppRuntime.dispose()

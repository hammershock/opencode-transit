// Run in a child process so the HTTP handler and the fixture share one file DB.
import { join } from "node:path"

const directory = process.argv[2]
const storage = process.argv[3]
if (!directory || !storage) throw new Error("missing fixture directory or storage")
process.env.OPENCODE_DB = join(storage, "task-wait.sqlite")
process.env.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = "true"

const { Context } = await import("effect")
const { HttpRouter } = await import("effect/unstable/http")
const { initProjectors } = await import("../../../src/server/projectors")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { Database } = await import("@opencode-ai/core/database/database")
const { SessionTaskOwner } = await import("@opencode-ai/core/session/task-owner")

initProjectors()
const handler = HttpRouter.toWebHandler(
  HttpApiApp.createRoutes(undefined, {
    id: "session_v2",
    features: new Set([
      "atomic_admission",
      "exact_owner_guard",
      "durable_queue",
      "reconcile",
      "exact_cancellation",
      "exact_result",
      "notification",
    ] as const),
  }),
  { disableLogger: true },
)
const send = (route: string, body: unknown, signal?: AbortSignal) =>
  handler.handler(
    new Request(`http://localhost${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      body: JSON.stringify(body),
      signal,
    }),
  Context.empty() as never,
  )
const parent = await send("/session", {}).then((response) => response.json() as Promise<{ id: string }>)
const child = await send("/session", { parentID: parent.id }).then(
  (response) => response.json() as Promise<{ id: string }>,
)
const sqlite = await import("bun:sqlite")
const local = new sqlite.Database(Database.path())
local
  .query(
    `INSERT INTO session_task (input_id, root_session_id, parent_session_id, parent_message_id,
  call_id, prompt_digest, child_session_id, description, agent_id, location_revision, state,
  backend, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    "msg_wait",
    parent.id,
    parent.id,
    "msg_parent",
    "call-task",
    "digest",
    child.id,
    "wait",
    "build",
    0,
    "admitted",
    "v2",
    Date.now(),
  )
local.close()
const controller = new AbortController()
const pending = send(
  `/api/session/${parent.id}/task/wait`,
  {
    targets: [
      {
        task_id: child.id,
        input_id: "msg_wait",
        invocation: {
          parent_session_id: parent.id,
          parent_message_id: "msg_parent",
          call_id: "call-task",
        },
      },
    ],
    timeout_ms: 5000,
  },
  controller.signal,
)
for (let attempt = 0; attempt < 100 && !SessionTaskOwner.watcherCount(Database.path(), child.id); attempt++)
  await Bun.sleep(10)
if (SessionTaskOwner.watcherCount(Database.path(), child.id) !== 1)
  throw new Error("wait did not register an owner watcher")
controller.abort()
const aborted = await Promise.race([
  pending.then(
    () => "settled" as const,
    () => "settled" as const,
  ),
  Bun.sleep(1000).then(() => "timeout" as const),
])
if (aborted !== "settled") throw new Error("HTTP handler did not settle after abort")
if (SessionTaskOwner.watcherCount(Database.path(), child.id) !== 0)
  throw new Error("HTTP abort leaked the Task owner watcher")
const state = new sqlite.Database(Database.path())
const row = state.query("SELECT state FROM session_task WHERE input_id = ?").get("msg_wait") as { state: string } | null
state.close()
if (row?.state !== "admitted") throw new Error("HTTP abort changed child admission")
console.log("HTTP abort released Task owner watcher")
process.exit(0)

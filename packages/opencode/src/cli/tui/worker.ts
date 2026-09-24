import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTaskDelivery } from "@opencode-ai/core/session/task-delivery"
import { SessionTaskTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Effect } from "effect"
import { and, eq } from "drizzle-orm"
import os from "node:os"

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  /** Private embedded-TUI operation. HTTP and model tools never receive this capability. */
  async archiveUnknown(input: {
    directory: string
    parentSessionID: string
    childSessionID: string
    inputID: string
    operationID: string
  }) {
    const uid = process.getuid?.()
    if (uid === undefined || !Number.isInteger(uid)) throw new Error("Local user identity unavailable")
    return AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: input.directory },
          Effect.gen(function* () {
            const instance = yield* InstanceRef
            if (!instance) return yield* Effect.fail(new Error("Task target unavailable"))
            const db = (yield* Database.Service).db
            const events = yield* EventV2Bridge.Service
            const parent = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(and(
                eq(SessionTable.id, SessionSchema.ID.make(input.parentSessionID)),
                eq(SessionTable.project_id, instance.project.id),
                eq(SessionTable.directory, instance.directory),
              ))
              .get()
            const child = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .innerJoin(SessionTaskTable, eq(SessionTaskTable.child_session_id, SessionTable.id))
              .where(
                and(
                  eq(SessionTable.id, SessionSchema.ID.make(input.childSessionID)),
                  eq(SessionTable.parent_id, SessionSchema.ID.make(input.parentSessionID)),
                  eq(SessionTable.project_id, instance.project.id),
                  eq(SessionTaskTable.input_id, input.inputID),
                  eq(SessionTaskTable.parent_session_id, input.parentSessionID),
                ),
              )
              .get()
            if (!parent || !child || !input.operationID) return yield* Effect.fail(new Error("Task target unavailable"))
            const receipt = yield* SessionTaskDelivery.archiveUnknown({
              childSessionID: SessionSchema.ID.make(input.childSessionID),
              inputID: input.inputID,
              operationID: input.operationID,
              actor: { kind: "user", id: `${os.userInfo().username}:${uid}` },
            }).pipe(Effect.provideService(EventV2.Service, events))
            if (!receipt) return yield* Effect.fail(new Error("Task target unavailable"))
            return { inputID: receipt.input_id, archived: receipt.abandoned_unknown }
          }),
        ),
      ),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)

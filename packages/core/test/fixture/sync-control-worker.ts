import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Context, DateTime, Effect, Layer } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import {
  PartTable,
  SessionTable,
  SessionInputTable,
  SessionTaskOperationTable,
  SessionTaskResultTable,
  SessionTaskWakeRevocationTable,
  SessionTaskSteerTable,
  SessionTaskStopTable,
  SessionTaskTable,
} from "@opencode-ai/core/session/sql"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskResult } from "@opencode-ai/core/session/task-result"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { BaiduCredential } from "@opencode-ai/core/sync/baidu-credential"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRoot } from "@opencode-ai/core/sync/root"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Flock } from "@opencode-ai/core/util/flock"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Prompt } from "@opencode-ai/core/session/prompt"

type Input = {
  readonly workerID: string
  readonly deviceID: string
  readonly deviceRoot: string
  readonly cloudRoot: string
}

type Command =
  | { readonly id: string; readonly op: "create"; readonly sessionID: string; readonly title: string; readonly parentID?: string }
  | { readonly id: string; readonly op: "update"; readonly sessionID: string; readonly title: string }
  | { readonly id: string; readonly op: "delete"; readonly sessionID: string }
  | { readonly id: string; readonly op: "query"; readonly sessionID: string }
  | {
      readonly id: string
      readonly op: "task"
      readonly sessionID: string
      readonly childID: string
      readonly holdSettlement?: boolean
    }
  | { readonly id: string; readonly op: "admit-task"; readonly sessionID: string; readonly childID: string }
  | { readonly id: string; readonly op: "task-stop"; readonly sessionID: string; readonly childID: string; readonly holdStop?: boolean }
  | { readonly id: string; readonly op: "task-result"; readonly sessionID: string; readonly rootID?: string; readonly childID: string; readonly holdResult?: boolean; readonly holdRecord?: boolean; readonly stop?: boolean }
  | { readonly id: string; readonly op: "reconcile-result"; readonly sessionID: string }
  | {
      readonly id: string
      readonly op: "task-v2"
      readonly sessionID: string
      readonly childID: string
      readonly holdEvent?: "steer" | "reconciled"
    }
  | { readonly id: string; readonly op: "flush-task"; readonly childID: string }
  | { readonly id: string; readonly op: "sync" }
  | { readonly id: string; readonly op: "expire-automatic-lease" }

const value = process.argv[2]
if (!value) throw new Error("usage: sync-control-worker <json>")
const input = JSON.parse(value) as Input
const spaceID = SyncRoot.accountScope("multiprocess")

function emit(message: object) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function providerError(operation: "download" | "upload", kind: "not-found" | "conflict") {
  return new SyncProvider.ProviderError("filesystem", operation, kind, false)
}

function filesystemProvider(): SyncProvider.Adapter {
  const locks = path.join(input.cloudRoot, ".locks")
  const absolute = (object: string) => path.join(input.cloudRoot, ...SyncProvider.objectPath(object).split("/"))
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const info = async (object: string): Promise<SyncProvider.ObjectInfo | undefined> => {
    const file = absolute(object)
    const metadata = await stat(file).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return
      throw cause
    })
    if (!metadata?.isFile()) return
    const bytes = new Uint8Array(await readFile(file))
    return { path: object, version: digest(bytes), size: bytes.length, modifiedAt: metadata.mtimeMs }
  }
  const audit = (operation: string, object: string) =>
    emit({ type: "provider-call", workerID: input.workerID, deviceID: input.deviceID, operation, path: object })
  const scan = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return []
      throw cause
    })
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.name !== ".locks" && !entry.name.includes(".tmp-"))
        .map(async (entry) => {
          const item = path.join(directory, entry.name)
          return entry.isDirectory() ? scan(item) : [item]
        }),
    )
    return nested.flat()
  }
  const list = async (prefix: string) => {
    audit("list", prefix)
    const files = await scan(absolute(prefix))
    const objects = await Promise.all(
      files.map(async (file) => {
        const object = path.relative(input.cloudRoot, file).split(path.sep).join("/")
        return (await info(object))!
      }),
    )
    return { objects }
  }
  return {
    id: "filesystem",
    list,
    listRecursive: list,
    async stat(object) {
      audit("stat", object)
      return info(object)
    },
    async download(object, version) {
      audit("download", object)
      const current = await info(object)
      if (!current) throw providerError("download", "not-found")
      if (version && version !== current.version) throw providerError("download", "conflict")
      return { ...current, bytes: new Uint8Array(await readFile(absolute(object))) }
    },
    async uploadAtomic(object, bytes, precondition) {
      audit("upload", object)
      return Flock.withLock(
        object,
        async () => {
          const current = await info(object)
          if (precondition.type === "absent" && current) throw providerError("upload", "conflict")
          if (precondition.type === "version" && current?.version !== precondition.version)
            throw providerError("upload", "conflict")
          const file = absolute(object)
          const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(temporary, bytes)
          await rename(temporary, file)
          return (await info(object))!
        },
        { dir: locks, staleMs: 5_000, timeoutMs: 10_000, baseDelayMs: 5, maxDelayMs: 25 },
      )
    },
    async deleteBatch(objects) {
      audit("delete", objects.map((item) => item.path).join(","))
      return Promise.all(
        objects.map((object) =>
          Flock.withLock(
            object.path,
            async () => {
              const current = await info(object.path)
              if (!current) return { path: object.path, status: "missing" as const }
              if (object.version && object.version !== current.version)
                return { path: object.path, status: "conflict" as const, version: current.version }
              await unlink(absolute(object.path))
              return { path: object.path, status: "deleted" as const }
            },
            { dir: locks, staleMs: 5_000, timeoutMs: 10_000, baseDelayMs: 5, maxDelayMs: 25 },
          ),
        ),
      )
    },
  }
}

const account = { id: "test-account", maskedDisplay: "tes***" }
const descriptor = {
  namespaceID: spaceID,
  name: "Session sync",
  protocol: { major: 1 as const, minor: 0 },
  encryption: "none" as const,
  createdAt: 1,
  updatedAt: 1,
  summary: { sessions: 0, devices: 2, updatedAt: 1 },
  revision: 1,
}
const state = {
  version: 2 as const,
  revision: 1,
  provider: "baidu" as const,
  deviceID: input.deviceID,
  deviceName: input.deviceID,
  account,
  activeSpaceID: spaceID,
  enabled: true,
  intervalSeconds: 30 as const,
  spaces: [{ accountID: account.id, descriptor, remoteRoot: SyncRoot.instanceRoot("multiprocess"), joinedAt: 1 }],
}
const active = {
  provider: "baidu" as const,
  deviceID: input.deviceID,
  deviceName: input.deviceID,
  account,
  namespaceID: spaceID,
  name: descriptor.name,
  encryption: descriptor.encryption,
  remoteRoot: SyncRoot.instanceRoot("multiprocess"),
  enabled: true,
  intervalSeconds: 30 as const,
}
const heldTaskEvents = new Map<string, Parameters<typeof SessionSync.capture>[1]>()

await mkdir(input.deviceRoot, { recursive: true })
await mkdir(input.cloudRoot, { recursive: true })

const secrets = new Map([
  [
    BaiduSyncProvider.credentialAccount(input.deviceID),
    JSON.stringify({
      appKey: "test-app",
      secretKey: "test-secret",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
  ],
])
const secureStore: SyncSecureStore.Store = {
  platform: "macos-keychain",
  get: async (key) => secrets.get(key),
  set: async (key, secret) => void secrets.set(key, secret),
  remove: async (key) => void secrets.delete(key),
}
const setupLayer = Layer.mock(SyncSetup.Service, {
  state: () => Effect.succeed(state),
  config: () => Effect.succeed(active),
  authenticated: () => Effect.succeed(true),
  cloudStatus: () =>
    Effect.succeed({
      status: "ready" as const,
      manifest: {
        version: 2 as const,
        state: "ready" as const,
        protocol: { major: 1 as const, minor: 0 },
        instanceID: "multiprocess",
        createdAt: 1,
      },
    }),
  applyRemoteDeletion: () => Effect.succeed(false),
})
const controlNode = {
  ...SyncControl.node,
  implementation: SyncControl.layerWith({
    credentialStore: async () => BaiduCredential.legacy(secureStore),
    secureStore: async () => secureStore,
    provider: filesystemProvider,
  }),
}
const globalRoot = {
  home: input.deviceRoot,
  data: path.join(input.deviceRoot, "data"),
  config: path.join(input.deviceRoot, "config"),
  state: path.join(input.deviceRoot, "state"),
  cache: path.join(input.deviceRoot, "cache"),
  tmp: path.join(input.deviceRoot, "tmp"),
  bin: path.join(input.deviceRoot, "bin"),
  log: path.join(input.deviceRoot, "log"),
  repos: path.join(input.deviceRoot, "repos"),
}
await Promise.all(
  Object.values(globalRoot)
    .slice(1)
    .map((directory) => mkdir(directory, { recursive: true })),
)
const layer = LayerNode.compile(
  LayerNode.group([
    controlNode,
    SessionProjector.node,
    EventV2.node,
    Database.node,
    SyncDatabase.node,
    SyncEventStore.node,
  ]),
  [
    [Global.node, Global.layerWith(globalRoot)],
    [Database.node, Database.layerFromPath(path.join(input.deviceRoot, "session.db"))],
    [SyncDatabase.node, SyncDatabase.layerFromPath(path.join(input.deviceRoot, "sync.db"))],
    [SyncSetup.node, setupLayer],
  ],
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      const events = Context.get(context, EventV2.Service)
      const database = Context.get(context, Database.Service).db
      const syncDatabase = Context.get(context, SyncDatabase.Service).db
      const store = Context.get(context, SyncEventStore.Service).scope(spaceID)
      const control = Context.get(context, SyncControl.Service)

      yield* events.listen((event) =>
        Effect.sync(() =>
          emit({
            type: "event",
            workerID: input.workerID,
            deviceID: input.deviceID,
            eventType: event.type,
            aggregateID: event.durable?.aggregateID,
          }),
        ),
      )
      emit({ type: "ready", workerID: input.workerID, deviceID: input.deviceID, pid: process.pid })

      yield* Effect.promise(async () => {
        const reader = createInterface({ input: process.stdin })
        for await (const line of reader) {
          if (!line.trim()) continue
          const command = JSON.parse(line) as Command
          try {
            if (command.op === "create") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const timestamp = Date.now()
              const event = await Effect.runPromise(
                events.publish(SessionV1.Event.Created, {
                  sessionID,
                  info: {
                    id: sessionID,
                    slug: command.sessionID,
                    ...(command.parentID ? { parentID: SessionV2.ID.make(command.parentID) } : {}),
                    projectID: ProjectV2.ID.make("global"),
                    directory: `/workspace/${input.deviceID}`,
                    syncSpaceID: spaceID,
                    title: command.title,
                    version: "test",
                    time: { created: timestamp, updated: timestamp },
                  },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, event, timestamp))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "query") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const session = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
              )
              const parts = await Effect.runPromise(
                database
                  .select({ data: PartTable.data })
                  .from(PartTable)
                  .where(eq(PartTable.session_id, sessionID))
                  .all(),
              )
              const tasks = await Effect.runPromise(
                database
                  .select({
                    inputID: SessionTaskTable.input_id,
                    childID: SessionTaskTable.child_session_id,
                    state: SessionTaskTable.state,
                    outcome: SessionTaskTable.outcome,
                    resultID: SessionTaskTable.result_message_id,
                  })
                  .from(SessionTaskTable)
                  .where(eq(SessionTaskTable.child_session_id, sessionID))
                  .all(),
              )
              const v2Tasks = await Effect.runPromise(
                database
                  .select()
                  .from(SessionTaskTable)
                  .where(eq(SessionTaskTable.child_session_id, sessionID))
                  .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
                  .all(),
              )
              const steers = await Effect.runPromise(database.select().from(SessionTaskSteerTable).all())
              const operations = await Effect.runPromise(database.select().from(SessionTaskOperationTable).all())
              const stopOperations = await Effect.runPromise(database.select().from(SessionTaskStopTable).all())
              const results = await Effect.runPromise(database.select().from(SessionTaskResultTable).all())
              const revocations = await Effect.runPromise(database.select().from(SessionTaskWakeRevocationTable).all())
              const notifications = await Effect.runPromise(database.select().from(SessionInputTable).all())
              const durable = await Effect.runPromise(
                database
                  .select({ seq: EventTable.seq, type: EventTable.type })
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, sessionID))
                  .all(),
              )
              const deletion = await Effect.runPromise(
                syncDatabase.get<{ session_id: string }>(sql`
                  SELECT session_id FROM sync_deletion_set WHERE space_id = ${spaceID} AND session_id = ${sessionID}
                `),
              )
              const controlProjection = await Effect.runPromise(
                syncDatabase.get<{ generation: number }>(sql`
                  SELECT generation FROM sync_control_projection WHERE space_id = ${spaceID}
                `),
              )
              const cursors = await Effect.runPromise(
                syncDatabase.all<{ device_id: string; cursor: number }>(
                  sql`SELECT device_id, cursor FROM sync_event_cursor WHERE space_id = ${spaceID}`,
                ),
              )
              const lease = await Effect.runPromise(
                syncDatabase.get<{ owner: string; expires_at: number }>(
                  sql`SELECT owner, expires_at FROM sync_event_lease WHERE name = ${`${spaceID}:automatic`}`,
                ),
              )
              emit({
                type: "response",
                id: command.id,
                ok: true,
                result: {
                  session: session ? { id: session.id, title: session.title } : undefined,
                  parts,
                  tasks,
                  v2Tasks: v2Tasks.map((task) => ({
                    inputID: task.input_id,
                    state: task.state,
                    eligibility: task.eligibility,
                    backend: task.backend,
                    abandoned: task.abandoned_unknown,
                  })),
                  steers: steers
                    .filter((steer) => v2Tasks.some((task) => task.input_id === steer.invocation_input_id))
                    .map((steer) => ({ inputID: steer.input_id, state: steer.state, reason: steer.reason })),
                  operations: operations
                    .filter((operation) => v2Tasks.some((task) => task.input_id === operation.input_id))
                    .map((operation) => ({
                      inputID: operation.input_id,
                      disposition: operation.disposition,
                      capacityState: operation.capacity_state,
                    })),
                  stopOperations: stopOperations
                    .filter((operation) => operation.child_session_id === sessionID)
                    .map((operation) => ({ operationID: operation.operation_id, members: operation.members })),
                  results: results.filter((row) => row.parent_session_id === sessionID)
                    .map((row) => ({ inputID: row.invocation_input_id, terminalID: row.terminal_event_id, notificationID: row.notification_input_id, outcome: row.outcome })),
                  revocations: revocations.filter((row) => row.parent_session_id === sessionID)
                    .map((row) => row.invocation_input_id),
                  notifications: notifications.filter((row) => row.session_id === sessionID && row.origin)
                    .map((row) => ({ id: row.id, origin: row.origin })),
                  durable,
                  deletion: Boolean(deletion),
                  controlProjection: controlProjection?.generation,
                  cursors,
                  lease,
                },
              })
              continue
            }
            if (command.op === "task-result") {
              const rootID = SessionV2.ID.make(command.rootID ?? command.sessionID)
              const parentID = SessionV2.ID.make(command.sessionID)
              const childID = SessionV2.ID.make(command.childID)
              const root = await Effect.runPromise(database.select().from(SessionTable)
                .where(eq(SessionTable.id, parentID)).get())
              if (!root) throw new Error(`Parent Session not found: ${rootID}`)
              const timestamp = Date.now()
              const inputID = SessionMessage.ID.make(`msg_result_input_${command.childID}`)
              const capture = async (event: Parameters<typeof SessionSync.capture>[1], hold = false) => {
                if (hold) heldTaskEvents.set(command.childID, event)
                else await Effect.runPromise(SessionSync.capture(store, event, Date.now()))
              }
              await capture(await Effect.runPromise(events.publish(SessionV1.Event.Created, {
                sessionID: childID,
                info: {
                  id: childID,
                  slug: command.childID,
                  projectID: root.project_id,
                  parentID,
                  directory: root.directory,
                  syncSpaceID: spaceID,
                  title: "Result sync child",
                  version: "test",
                  time: { created: timestamp, updated: timestamp },
                },
                task: {
                  inputID,
                  rootSessionID: rootID,
                  parentSessionID: parentID,
                  parentMessageID: `msg_parent_result_${command.childID}`,
                  callID: `call_result_${command.childID}`,
                  promptDigest: "result",
                  childSessionID: childID,
                  description: "result sync work",
                  agentID: "build",
                  locationRevision: 0,
                  backend: "v2",
                  background: true,
                },
                taskInput: { messageID: inputID, prompt: Prompt.make({ text: "Work" }), delivery: "queue" },
              })))
              if (command.stop) {
                const emitted: Parameters<typeof SessionSync.capture>[1][] = []
                const unsubscribe = await Effect.runPromise(events.listen((event) =>
                  Effect.sync(() => { if (event.type === SessionEvent.DelegationWakeRevoked.type && event.durable) emitted.push(event as Parameters<typeof SessionSync.capture>[1]) })))
                await Effect.runPromise(SessionTaskResult.stop(Context.get(context, Database.Service), events, parentID))
                await Effect.runPromise(unsubscribe)
                for (const event of emitted) await capture(event)
              }
              await capture(await Effect.runPromise(events.publish(SessionTaskEvent.Settled, {
                sessionID: childID,
                inputID,
                outcome: "completed",
                resultMessageID: `msg_result_${command.childID}`,
                timestamp: timestamp + 1,
              })))
              if (command.holdRecord) {
                emit({ type: "response", id: command.id, ok: true })
                continue
              }
              const emitted: Parameters<typeof SessionSync.capture>[1][] = []
              const unsubscribe = await Effect.runPromise(events.listen((event) =>
                Effect.sync(() => { if (event.type === SessionEvent.DelegationResultRecorded.type && event.durable) emitted.push(event as Parameters<typeof SessionSync.capture>[1]) })))
              await Effect.runPromise(SessionTaskResult.record(database, events, inputID))
              await Effect.runPromise(unsubscribe)
              if (emitted.length !== 1) throw new Error(`Expected one parent result event, got ${emitted.length}`)
              await capture(emitted[0]!, command.holdResult)
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "reconcile-result") {
              const rootID = SessionV2.ID.make(command.sessionID)
              const emitted: Parameters<typeof SessionSync.capture>[1][] = []
              const unsubscribe = await Effect.runPromise(events.listen((event) =>
                Effect.sync(() => { if (event.type === SessionEvent.DelegationResultRecorded.type && event.durable) emitted.push(event as Parameters<typeof SessionSync.capture>[1]) })))
              await Effect.runPromise(SessionTaskResult.reconcile(Context.get(context, Database.Service), events, rootID))
              await Effect.runPromise(unsubscribe)
              for (const event of emitted) await Effect.runPromise(SessionSync.capture(store, event, Date.now()))
              emit({ type: "response", id: command.id, ok: true, count: emitted.length })
              continue
            }
            if (command.op === "task-stop") {
              const rootID = SessionV2.ID.make(command.sessionID)
              const childID = SessionV2.ID.make(command.childID)
              const root = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, rootID)).get(),
              )
              if (!root) throw new Error(`Parent Session not found: ${rootID}`)
              const timestamp = Date.now()
              const first = SessionMessage.ID.make(`msg_stop_${command.childID}_a`)
              const second = SessionMessage.ID.make(`msg_stop_${command.childID}_b`)
              const admission = {
                inputID: first,
                rootSessionID: rootID,
                parentSessionID: rootID,
                parentMessageID: `msg_parent_stop_${command.childID}_a`,
                callID: `call_stop_${command.childID}_a`,
                promptDigest: "stop-a",
                childSessionID: childID,
                description: "stop sync work",
                agentID: "build",
                locationRevision: 0,
                backend: "v2" as const,
              }
              const created = await Effect.runPromise(
                events.publish(SessionV1.Event.Created, {
                  sessionID: childID,
                  info: {
                    id: childID,
                    slug: command.childID,
                    projectID: root.project_id,
                    parentID: rootID,
                    directory: root.directory,
                    syncSpaceID: spaceID,
                    title: "Stopped V2 sync child",
                    version: "test",
                    time: { created: timestamp, updated: timestamp },
                  },
                  task: admission,
                  taskInput: { messageID: first, prompt: Prompt.make({ text: "A" }), delivery: "queue" },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, created, timestamp))
              const queued = await Effect.runPromise(
                events.publish(SessionEvent.PromptAdmitted, {
                  sessionID: childID,
                  messageID: second,
                  timestamp: DateTime.makeUnsafe(timestamp + 1),
                  prompt: Prompt.make({ text: "B" }),
                  delivery: "queue",
                  task: {
                    kind: "invocation",
                    admission: {
                      ...admission,
                      inputID: second,
                      parentMessageID: `msg_parent_stop_${command.childID}_b`,
                      callID: `call_stop_${command.childID}_b`,
                      promptDigest: "stop-b",
                    },
                  },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, queued, timestamp + 1))
              const stopped = await Effect.runPromise(
                events.publish(SessionTaskEvent.Stopped, {
                  sessionID: childID,
                  rootSessionID: rootID,
                  parentSessionID: rootID,
                  operationID: `stop_${command.childID}`,
                  intent: "stop",
                  actorKind: "user",
                  actorID: "sync-test-user",
                  members: [
                    { inputID: first, state: "pending" },
                    { inputID: second, state: "pending" },
                  ],
                  timestamp: timestamp + 2,
                }),
              )
              if (command.holdStop) heldTaskEvents.set(command.childID, stopped)
              else await Effect.runPromise(SessionSync.capture(store, stopped, timestamp + 2))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "task-v2") {
              const rootID = SessionV2.ID.make(command.sessionID)
              const childID = SessionV2.ID.make(command.childID)
              const root = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, rootID)).get(),
              )
              if (!root) throw new Error(`Parent Session not found: ${rootID}`)
              const timestamp = Date.now()
              const first = `msg_v2_${command.childID}_a`
              const steer = `msg_v2_${command.childID}_steer`
              const next = `msg_v2_${command.childID}_b`
              const admission = {
                inputID: first,
                rootSessionID: rootID,
                parentSessionID: rootID,
                parentMessageID: `msg_parent_v2_${command.childID}_a`,
                callID: `call_v2_${command.childID}_a`,
                promptDigest: "v2-a",
                childSessionID: childID,
                description: "V2 sync work",
                agentID: "build",
                locationRevision: 0,
                backend: "v2" as const,
              }
              const publish = async (
                definition: Parameters<typeof events.publish>[0],
                data: object,
                at: number,
                hold = false,
              ) => {
                const event = await Effect.runPromise(events.publish(definition, data))
                const durable = event as Parameters<typeof SessionSync.capture>[1]
                if (hold) heldTaskEvents.set(command.childID, durable)
                else await Effect.runPromise(SessionSync.capture(store, durable, at))
              }
              await publish(
                SessionV1.Event.Created,
                {
                  sessionID: childID,
                  info: {
                    id: childID,
                    slug: command.childID,
                    projectID: root.project_id,
                    parentID: rootID,
                    directory: root.directory,
                    syncSpaceID: spaceID,
                    title: "V2 sync task child",
                    version: "test",
                    time: { created: timestamp, updated: timestamp },
                  },
                  task: admission,
                  taskInput: { messageID: first, prompt: Prompt.make({ text: "A" }), delivery: "queue" },
                },
                timestamp,
              )
              await publish(
                SessionEvent.Prompted,
                {
                  sessionID: childID,
                  messageID: first,
                  timestamp: DateTime.makeUnsafe(timestamp),
                  prompt: Prompt.make({ text: "A" }),
                  delivery: "queue",
                },
                timestamp + 1,
              )
              await publish(
                SessionEvent.PromptAdmitted,
                {
                  sessionID: childID,
                  messageID: steer,
                  timestamp: DateTime.makeUnsafe(timestamp + 2),
                  prompt: Prompt.make({ text: "steer A" }),
                  delivery: "steer",
                  task: {
                    kind: "steer",
                    invocationInputID: first,
                    operationID: `steer_${command.childID}`,
                    promptDigest: "steer-a",
                  },
                },
                timestamp + 2,
                command.holdEvent === "steer",
              )
              if (command.holdEvent === "steer") {
                emit({ type: "response", id: command.id, ok: true })
                continue
              }
              await publish(
                SessionEvent.PromptAdmitted,
                {
                  sessionID: childID,
                  messageID: next,
                  timestamp: DateTime.makeUnsafe(timestamp + 3),
                  prompt: Prompt.make({ text: "B" }),
                  delivery: "queue",
                  task: {
                    kind: "invocation",
                    admission: {
                      ...admission,
                      inputID: next,
                      parentMessageID: `msg_parent_v2_${command.childID}_b`,
                      callID: `call_v2_${command.childID}_b`,
                      promptDigest: "v2-b",
                    },
                  },
                },
                timestamp + 3,
              )
              await publish(
                SessionTaskEvent.ArchivedUnknown,
                {
                  sessionID: childID,
                  inputID: first,
                  operationID: `archive_${command.childID}`,
                  actorID: "sync-test-user",
                  timestamp: timestamp + 4,
                },
                timestamp + 4,
              )
              await publish(
                SessionTaskEvent.Reconciled,
                {
                  sessionID: childID,
                  inputID: next,
                  operationID: `resume_${command.childID}`,
                  actorKind: "user",
                  actorID: "sync-test-user",
                  disposition: "resume_pending",
                  capacityState: "available",
                  timestamp: timestamp + 5,
                },
                timestamp + 5,
                command.holdEvent === "reconciled",
              )
              if (command.holdEvent === "reconciled") {
                emit({ type: "response", id: command.id, ok: true })
                continue
              }
              await publish(
                SessionEvent.Prompted,
                {
                  sessionID: childID,
                  messageID: next,
                  timestamp: DateTime.makeUnsafe(timestamp + 3),
                  prompt: Prompt.make({ text: "B" }),
                  delivery: "queue",
                },
                timestamp + 6,
              )
              await publish(
                SessionTaskEvent.Settled,
                {
                  sessionID: childID,
                  inputID: next,
                  outcome: "completed",
                  resultMessageID: `msg_v2_result_${command.childID}`,
                  timestamp: timestamp + 7,
                },
                timestamp + 7,
              )
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "task") {
              const rootID = SessionV2.ID.make(command.sessionID)
              const childID = SessionV2.ID.make(command.childID)
              const root = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, rootID)).get(),
              )
              if (!root) throw new Error(`Parent Session not found: ${rootID}`)
              const timestamp = Date.now()
              const admission = {
                inputID: `msg_${command.childID}`,
                rootSessionID: rootID,
                parentSessionID: rootID,
                parentMessageID: `msg_parent_${command.childID}`,
                callID: `call_${command.childID}`,
                promptDigest: "sync-task-test",
                childSessionID: childID,
                description: "sync task",
                agentID: "build",
                locationRevision: 0,
                backend: "legacy" as const,
              }
              const created = await Effect.runPromise(
                events.publish(
                  SessionV1.Event.Created,
                  {
                    sessionID: childID,
                    info: {
                      id: childID,
                      slug: command.childID,
                      projectID: root.project_id,
                      parentID: rootID,
                      directory: root.directory,
                      syncSpaceID: spaceID,
                      title: "sync task child",
                      version: "test",
                      time: { created: timestamp, updated: timestamp },
                    },
                    task: admission,
                  },
                  { commit: () => SessionTask.validate(database, admission.inputID) },
                ),
              )
              await Effect.runPromise(SessionSync.capture(store, created, timestamp))
              const promoted = await Effect.runPromise(
                events.publish(SessionTaskEvent.Promoted, {
                  sessionID: childID,
                  inputID: admission.inputID,
                  timestamp: timestamp + 1,
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, promoted, timestamp + 1))
              const settled = await Effect.runPromise(
                events.publish(SessionTaskEvent.Settled, {
                  sessionID: childID,
                  inputID: admission.inputID,
                  outcome: "completed",
                  resultMessageID: `msg_result_${command.childID}`,
                  timestamp: timestamp + 2,
                }),
              )
              if (command.holdSettlement) heldTaskEvents.set(command.childID, settled)
              else await Effect.runPromise(SessionSync.capture(store, settled, timestamp + 2))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "admit-task") {
              const event = await Effect.runPromise(
                events.publish(SessionTaskEvent.Admitted, {
                  sessionID: SessionV2.ID.make(command.childID),
                  admission: {
                    inputID: `msg_late_${command.childID}`,
                    rootSessionID: SessionV2.ID.make(command.sessionID),
                    parentSessionID: SessionV2.ID.make(command.sessionID),
                    parentMessageID: `msg_parent_late_${command.childID}`,
                    callID: `call_late_${command.childID}`,
                    promptDigest: "sync-task-late-test",
                    childSessionID: SessionV2.ID.make(command.childID),
                    description: "late sync task",
                    agentID: "build",
                    locationRevision: 0,
                    backend: "legacy" as const,
                  },
                  timestamp: Date.now(),
                }),
              )
              heldTaskEvents.set(command.childID, event)
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "flush-task") {
              const pending = heldTaskEvents.get(command.childID)
              if (!pending) throw new Error(`No held Task event: ${command.childID}`)
              await Effect.runPromise(SessionSync.capture(store, pending))
              heldTaskEvents.delete(command.childID)
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "update") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const current = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
              )
              if (!current) throw new Error(`Session not found: ${sessionID}`)
              const timestamp = Date.now()
              const event = await Effect.runPromise(
                events.publish(SessionV1.Event.Updated, {
                  sessionID,
                  info: {
                    id: sessionID,
                    slug: current.slug,
                    projectID: current.project_id,
                    directory: current.directory,
                    syncSpaceID: spaceID,
                    title: command.title,
                    version: current.version,
                    time: { created: current.time_created, updated: timestamp },
                  },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, event, timestamp))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "delete") {
              await Effect.runPromise(control.deleteSession({ sessionID: command.sessionID }))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "sync") {
              await Effect.runPromise(control.now())
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            await Effect.runPromise(
              syncDatabase.run(sql`UPDATE sync_event_lease SET expires_at = 0 WHERE name = ${`${spaceID}:automatic`}`),
            )
            emit({ type: "response", id: command.id, ok: true })
          } catch (cause) {
            emit({ type: "response", id: command.id, ok: false, error: String(cause) })
          }
        }
      })
    }),
  ),
).catch((cause) => {
  emit({ type: "fatal", workerID: input.workerID, deviceID: input.deviceID, error: String(cause) })
  process.exitCode = 1
})

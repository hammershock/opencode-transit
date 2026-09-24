import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTaskResultTable, SessionTaskTable } from "@opencode-ai/core/session/sql"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTaskDelivery } from "@opencode-ai/core/session/task-delivery"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"
import { SessionTaskSteerTable } from "@opencode-ai/core/session/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { TaskTool } from "@/tool/task"
import { TaskInterruptTool } from "@/tool/task-interrupt"
import { TaskStopTool } from "@/tool/task-stop"
import { MessageID } from "@/session/schema"
import { asc, eq } from "drizzle-orm"
import { Duration, Effect } from "effect"

const directory = process.env.TASK_V2_TEST_DIRECTORY
if (!directory) throw new Error("TASK_V2_TEST_DIRECTORY is required")
const llmURL = process.env.TASK_V2_TEST_LLM_URL
if (!llmURL) throw new Error("TASK_V2_TEST_LLM_URL is required")

const backend: SessionTaskCapability.Backend = {
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
}

const result = await AppRuntime.runPromise(
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const instance = yield* instances.load({ directory })
    return yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      const chat = yield* session.create({ title: "Task V2 process fixture" })
      const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: directory, root: directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: Date.now() },
      }
      yield* session.updateMessage(assistant)
      const tool = yield* TaskTool.pipe(
        Effect.provideService(SessionTaskCapability.Service, backend),
        Effect.provideService(TargetRegistry.Service, TargetRegistry.make({ directory })),
      )
      const def = yield* tool.init()
      const receipt = yield* def.execute(
        { description: "inspect cache", prompt: "check cache", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call-v2-consume",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const location = yield* (yield* SessionLocationAccess.Service).require(
        SessionV2.ID.make(receipt.metadata.sessionId),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Catalog.Service.use((catalog) =>
        catalog.transform((draft) => {
          draft.provider.update(model.providerID, (provider) => {
            provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llmURL, settings: {} }
            provider.request.body.apiKey = "test-key"
          })
          draft.model.update(model.providerID, model.modelID, () => {})
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const execution = yield* SessionExecution.Service
      if (process.env.TASK_V2_TEST_INTERRUPT === "1") {
        const child = SessionV2.ID.make(receipt.metadata.sessionId)
        const active = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const row = yield* database.db
              .select()
              .from(SessionTaskTable)
              .where(eq(SessionTaskTable.child_session_id, child))
              .get()
            if (row?.state === "active" && row.owner_generation) return row
            yield* Effect.sleep(Duration.millis(25))
          }
          return yield* Effect.die("Task never acquired an active owner")
        })
        const followups = yield* Effect.forEach(["B", "C"], (letter) =>
          def.execute(
            {
              description: `follow-up ${letter}`,
              prompt: `work ${letter}`,
              subagent_type: "general",
              task_id: child,
              background: true,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: `call-v2-interrupt-${letter}`,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )
        yield* Effect.promise(() => Bun.write(`${directory}/task-v2-interrupt-admitted`, "ready"))
        for (let attempt = 0; attempt < 400; attempt++) {
          if (yield* Effect.promise(() => Bun.file(`${directory}/task-v2-interrupt-go`).exists())) break
          if (attempt === 399) return yield* Effect.die("Task interrupt fixture was never released")
          yield* Effect.sleep(Duration.millis(25))
        }
        const events = yield* EventV2Bridge.Service
        const interrupt = yield* TaskInterruptTool.pipe(Effect.provideService(SessionTaskCapability.Service, backend))
        const interruptedOutput = yield* (yield* interrupt.init()).execute(
          {
            target: {
              task_id: child,
              input_id: active.input_id,
              invocation: {
                parent_session_id: SessionV2.ID.make(chat.id),
                parent_message_id: assistant.id,
                call_id: "call-v2-consume",
              },
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call-v2-interrupt-control",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const interruptedReceipt = JSON.parse(interruptedOutput.output) as { input_id: string; state: string }
        const interrupted = { inputID: interruptedReceipt.input_id, state: interruptedReceipt.state }
        yield* Effect.promise(() =>
          Bun.write(
            `${directory}/task-v2-interrupt-ready.json`,
            JSON.stringify({
              interrupted,
              active: active.input_id,
              followups: followups.map((item) => item.metadata.invocation.childMessageID),
            }),
          ),
        )
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.child_session_id, child))
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
            .all()
          if (rows.length === 3 && rows.every((row) => row.state === "settled"))
            return {
              child,
              rows: rows.map((row) => ({ input: row.input_id, state: row.state, outcome: row.outcome })),
              old: yield* SessionTaskControl.interrupt({
                childSessionID: child,
                inputID: active.input_id,
                invocation: {
                  parentSessionID: SessionV2.ID.make(chat.id),
                  parentMessageID: assistant.id,
                  callID: "call-v2-consume",
                },
                actor: { kind: "parent", id: chat.id },
              }).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.provideService(Database.Service, database),
                Effect.provideService(SessionExecution.Service, execution),
              ),
            }
          yield* Effect.sleep(Duration.millis(25))
        }
        return yield* Effect.die("Interrupted Task queue did not settle")
      }
      if (process.env.TASK_V2_TEST_STOP === "1") {
        const child = SessionV2.ID.make(receipt.metadata.sessionId)
        const active = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const row = yield* database.db
              .select()
              .from(SessionTaskTable)
              .where(eq(SessionTaskTable.child_session_id, child))
              .get()
            if (row?.state === "active" && row.owner_generation) return row
            yield* Effect.sleep(Duration.millis(25))
          }
          return yield* Effect.die("Task never acquired an active owner")
        })
        const followups = yield* Effect.forEach(["B", "C"], (letter) =>
          def.execute(
            {
              description: `follow-up ${letter}`,
              prompt: `work ${letter}`,
              subagent_type: "general",
              task_id: child,
              background: true,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: `call-v2-stop-${letter}`,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(`${directory}/task-v2-stop-admitted.json`, JSON.stringify({ active: active.input_id })),
        )
        for (let attempt = 0; attempt < 400; attempt++) {
          if (yield* Effect.promise(() => Bun.file(`${directory}/task-v2-stop-go`).exists())) break
          if (attempt === 399) return yield* Effect.die("Task stop fixture was never released")
          yield* Effect.sleep(Duration.millis(25))
        }
        const events = yield* EventV2Bridge.Service
        const stop = yield* TaskStopTool.pipe(Effect.provideService(SessionTaskCapability.Service, backend))
        const stoppedOutput = yield* (yield* stop.init()).execute(
          { task_id: child },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call-v2-stop-control",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const stoppedReceipt = JSON.parse(stoppedOutput.output) as {
          operation_id: string
          data: { input_id: string; state: string }[]
        }
        const stopped = {
          operationID: stoppedReceipt.operation_id,
          data: stoppedReceipt.data.map((item) => ({ inputID: item.input_id, state: item.state })),
        }
        const later = yield* def.execute(
          {
            description: "follow-up D",
            prompt: "work D",
            subagent_type: "general",
            task_id: child,
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call-v2-stop-D",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        yield* Effect.promise(() =>
          Bun.write(
            `${directory}/task-v2-stop-ready.json`,
            JSON.stringify({
              stopped,
              active: active.input_id,
              followups: followups.map((item) => item.metadata.invocation.childMessageID),
              later: later.metadata.invocation.childMessageID,
            }),
          ),
        )
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.child_session_id, child))
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
            .all()
          const parentResults = yield* database.db.select().from(SessionTaskResultTable)
            .where(eq(SessionTaskResultTable.child_session_id, child)).all()
          if (rows.length === 4 && rows.every((row) => row.state === "settled") && parentResults.length === 4)
            return {
              child,
              rows: rows.map((row) => ({ input: row.input_id, state: row.state, outcome: row.outcome })),
              parentResults: parentResults.map((item) => ({
                input: item.invocation_input_id,
                outcome: item.outcome,
                notification: item.notification_input_id,
              })),
              retry: yield* SessionTaskControl.stop({
                parentSessionID: SessionV2.ID.make(chat.id),
                childSessionID: child,
                operationID: stopped.operationID,
                actor: { kind: "parent", id: chat.id },
              }).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.provideService(Database.Service, database),
                Effect.provideService(SessionExecution.Service, execution),
              ),
            }
          yield* Effect.sleep(Duration.millis(25))
        }
        return yield* Effect.die("Stopped Task did not settle")
      }
      if (process.env.TASK_V2_TEST_SEQUENCE === "1") {
        const child = SessionV2.ID.make(receipt.metadata.sessionId)
        const initialRetry = yield* def.execute(
          { description: "inspect cache", prompt: "check cache", subagent_type: "general", background: true },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call-v2-consume",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const active = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const row = yield* database.db
              .select()
              .from(SessionTaskTable)
              .where(eq(SessionTaskTable.child_session_id, child))
              .get()
            if (row?.state === "active") return row
            yield* Effect.sleep(Duration.millis(25))
          }
          return yield* Effect.die("Task never became active")
        })
        const events = yield* EventV2Bridge.Service
        const steer = yield* SessionTaskDelivery.send({
          childSessionID: child,
          invocationInputID: active.input_id,
          invocation: {
            parentSessionID: SessionV2.ID.make(chat.id),
            parentMessageID: assistant.id,
            callID: "call-v2-consume",
          },
          operationID: "send-active-steer",
          text: "steer A",
        }).pipe(
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(Database.Service, database),
          Effect.provideService(SessionExecution.Service, execution),
        )
        const executeFollowup = (letter: "B" | "C") =>
          def.execute(
            {
              description: `follow-up ${letter}`,
              prompt: `work ${letter}`,
              subagent_type: "general",
              task_id: child,
              background: true,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: `call-v2-${letter}`,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
        const [firstB, duplicateB] = yield* Effect.all([executeFollowup("B"), executeFollowup("B")], {
          concurrency: "unbounded",
        })
        const newB = firstB.output.includes("already admitted") ? duplicateB : firstB
        const retriedB = firstB.output.includes("already admitted") ? firstB : duplicateB
        const followups = [newB, yield* executeFollowup("C")]
        yield* Effect.promise(() =>
          Bun.write(
            `${directory}/task-v2-ready.json`,
            JSON.stringify({
              steer,
              initialRetry: {
                input: initialRetry.metadata.invocation.childMessageID,
                output: initialRetry.output,
              },
              duplicateB: {
                input: retriedB.metadata.invocation.childMessageID,
                output: retriedB.output,
              },
              followups: followups.map((item) => item.metadata.invocation.childMessageID),
              followupOutputs: followups.map((item) => item.output),
            }),
          ),
        )
        yield* execution.wakeAndWait(child)
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.child_session_id, child))
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.input_id))
            .all()
          if (rows.length === 3 && rows.every((row) => row.state === "settled")) {
            const settledRetry = yield* executeFollowup("B")
            const steerRow = yield* database.db
              .select()
              .from(SessionTaskSteerTable)
              .where(eq(SessionTaskSteerTable.operation_id, "send-active-steer"))
              .get()
            return {
              database: database.filename,
              child,
              rows: rows.map((row) => ({
                input: row.input_id,
                state: row.state,
                outcome: row.outcome,
                result: row.result_message_id,
              })),
              steer: { admitted: steer.state, state: steerRow?.state },
              settledRetry: {
                input: settledRetry.metadata.invocation.childMessageID,
                output: settledRetry.output,
              },
            }
          }
          yield* Effect.sleep(Duration.millis(25))
        }
        return yield* Effect.die("Task queue did not settle")
      }
      yield* execution.wakeAndWait(SessionV2.ID.make(receipt.metadata.sessionId))
      const row = yield* database.db
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.child_session_id, receipt.metadata.sessionId))
        .get()
      return {
        database: database.filename,
        parent: chat.id,
        child: receipt.metadata.sessionId,
        input: row?.input_id,
        state: row?.state,
        outcome: row?.outcome,
        result: row?.result_message_id,
        parentResult: row
          ? yield* database.db.select().from(SessionTaskResultTable)
              .where(eq(SessionTaskResultTable.invocation_input_id, row.input_id)).get()
          : undefined,
      }
    }).pipe(Effect.provideService(InstanceRef, instance))
  }).pipe(Effect.scoped),
)

process.stdout.write(`TASK_V2_RESULT:${JSON.stringify(result)}\n`)
await AppRuntime.dispose()

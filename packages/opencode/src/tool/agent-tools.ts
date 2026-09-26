import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInterruption } from "@opencode-ai/core/session/interruption"
import { SessionLegacyOwner } from "@opencode-ai/core/session/legacy-owner"
import { SessionPeerMessage } from "@opencode-ai/core/session/peer-message"
import { SessionPeerRoute } from "@opencode-ai/core/session/peer-route"
import { SessionPeerWait } from "@opencode-ai/core/session/peer-wait"
import { SessionAgentWaitOwner } from "@opencode-ai/core/session/agent-wait-owner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionExecutionPauseTable,
  SessionAgentWaitTable,
  SessionInterruptionTable,
  SessionPeerMessageTable,
  SessionPeerReceiptTable,
  SessionPeerUserMessageTable,
  SessionTaskResultTable,
  SessionTaskTable,
  SessionTable,
  PartTable,
  SessionMessageTable,
} from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionTaskWait } from "@opencode-ai/core/session/task-wait"
import { SessionTaskResult } from "@opencode-ai/core/session/task-result"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { and, desc, eq, gte, inArray } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Option, Schema } from "effect"
import { Tool } from "./tool"
import { TaskTool, type TaskPromptOps } from "./task"
import { SessionID } from "@/session/schema"
import { SessionAgentTool } from "@opencode-ai/schema/session-agent-tool"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"

interface LegacyPromptInterface {
  admitPeer(input: {
    sessionID: SessionID
    messageID: string
    text: string
    wake: boolean
    queue?: boolean
  }): Effect.Effect<void, unknown>
}
class LegacyPrompt extends Context.Service<LegacyPrompt, LegacyPromptInterface>()("@opencode/SessionPrompt") {}
const spawns = KeyedMutex.makeUnsafe<string>()

function receipt(title: string, value: unknown) {
  return { title, output: JSON.stringify(value), metadata: {} }
}

function failure(title: string, cause: Cause.Cause<unknown>) {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
  const error = Cause.squash(cause)
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "agent_unavailable"
  return Effect.succeed(receipt(title, { status: "unavailable", reason: code }))
}

export const AgentSpawnTool = Tool.define(
  "agent_spawn",
  Effect.gen(function* () {
    const task = yield* TaskTool
    const database = yield* Database.Service
    return {
      description:
        "Start an independent Agent session with a readable alias. Return promptly; use agent_wait for results.",
      parameters: SessionAgentTool.Spawn,
      execute: (
        input: { alias: string; prompt: string; subagent_type: string; target?: string; directory?: string },
        ctx: Tool.Context,
      ) =>
        spawns
          .withLock(`${ctx.sessionID}:${input.alias}`)(
            Effect.gen(function* () {
              if (!ctx.callID || !SessionPeerRoute.validAlias(input.alias))
                return receipt("Invalid Agent alias", { status: "invalid_alias" })
              const existing = (yield* SessionPeerRoute.list(SessionSchema.ID.make(ctx.sessionID)).pipe(
                Effect.provideService(Database.Service, database),
              )).find((route) => route.alias === input.alias)
              if (existing && (existing.origin_kind !== "spawn" || existing.origin_id !== ctx.callID))
                return receipt("Agent alias unavailable", { status: "alias_conflict" })
              const underlying = yield* task.init()
              const result = yield* underlying.execute(
                {
                  description: input.alias.split("/").at(-1) ?? input.alias,
                  prompt: input.prompt,
                  subagent_type: input.subagent_type,
                  target: input.target,
                  directory: input.directory,
                  background: true,
                },
                ctx,
              )
              const sessionID = result.metadata.sessionId
              if (typeof sessionID !== "string") return receipt("Agent spawn unavailable", { status: "unavailable" })
              yield* SessionPeerRoute.bind({
                sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
                targetSessionID: SessionSchema.ID.make(sessionID),
                alias: input.alias,
                origin: { kind: "spawn", id: ctx.callID },
              }).pipe(Effect.provideService(Database.Service, database))
              return {
                title: `Queued ${input.alias}`,
                output: JSON.stringify({ alias: input.alias, status: "queued", session_id: sessionID }),
                metadata: { ...result.metadata, alias: input.alias },
              }
            }),
          )
          .pipe(Effect.catchCause((cause) => failure("Agent spawn unavailable", cause))),
    }
  }),
)

export const AgentConnectTool = Tool.define(
  "agent_connect",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Connect an alias to a Session ID supplied by the user in this conversation. Does not send or run work.",
      parameters: SessionAgentTool.Connect,
      execute: (input: { alias: string; session_id: string; user_message_id?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const candidates = input.user_message_id
            ? [input.user_message_id]
            : (yield* database.db
                .select({ id: SessionPeerUserMessageTable.message_id })
                .from(SessionPeerUserMessageTable)
                .where(eq(SessionPeerUserMessageTable.session_id, SessionSchema.ID.make(ctx.sessionID)))
                .orderBy(desc(SessionPeerUserMessageTable.time_created))
                .limit(32)
                .all()).map((row) => row.id)
          for (const id of candidates) {
            const bound = yield* SessionPeerRoute.bind({
              sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
              targetSessionID: SessionSchema.ID.make(input.session_id),
              alias: input.alias,
              origin: { kind: "user_message", id },
            }).pipe(Effect.exit)
            if (Exit.isSuccess(bound))
              return {
                ...receipt(`Connected ${input.alias}`, { alias: input.alias, status: "connected" }),
                metadata: { targetSessionID: input.session_id },
              }
          }
          return receipt("Agent connect unavailable", { status: "unknown_or_forbidden" })
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause((cause) => failure("Agent connect unavailable", cause)),
        ),
    }
  }),
)

export const AgentInteractTool = Tool.define(
  "agent_interact",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "For an ordinary progress question, ask the responsible Agent for completed work, current step and blockers, and tell it to continue its original task. Also sends replies and notices. A status of admitted means accepted for delivery, not delivered or processed; wait for a reply before reporting the Agent's progress.",
      parameters: SessionAgentTool.Interact,
      execute: (
        input: {
          target: string
          message: string
          kind?: "request" | "reply" | "notice"
          reply_to?: string
          queue?: boolean
          resume?: boolean
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          if (!ctx.callID) return receipt("Agent interaction unavailable", { status: "invalid_operation" })
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          if (!execution) return receipt("Agent interaction unavailable", { status: "owner_unavailable" })
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          const prompt = Option.getOrUndefined(yield* Effect.serviceOption(LegacyPrompt))
          const row = yield* SessionPeerMessage.send({
            sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
            alias: input.target,
            text: input.message,
            kind: input.kind,
            replyTo: input.reply_to,
            queue: input.queue,
            resume: input.resume,
            operationID: `agent_interact:${ctx.messageID}:${ctx.callID}`,
            deliverLegacy: (message) => {
              const admit = ops?.admitPeer ?? prompt?.admitPeer
              if (!admit) return Effect.fail(new SessionPeerMessage.Unavailable())
              return admit({
                sessionID: SessionID.make(message.target_session_id),
                messageID: message.id,
                text: SessionPeerMessage.render(message),
                wake: message.kind !== "notice",
                queue: message.queued,
              })
            },
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return {
            ...receipt(`Interacted with ${input.target}`, {
              alias: input.target,
              session_id: row.target_session_id,
              status: row.delivery,
              reason: row.failure_reason,
              message_id: row.id,
              request_id: row.request_id,
              queued: row.queued,
            }),
            metadata: { targetSessionID: row.target_session_id },
          }
        }).pipe(Effect.catchCause((cause) => failure("Agent interaction unavailable", cause))),
    }
  }),
)

export const AgentInspectTool = Tool.define(
  "agent_inspect",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Read whether a visible Agent is running, idle, or interrupted and its current tool activity. Does not ask for task progress.",
      parameters: SessionAgentTool.Inspect,
      execute: (input: { alias?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const routes = input.alias
            ? [
                yield* SessionPeerRoute.resolve({
                  sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
                  alias: input.alias,
                  capability: "inspect",
                }),
              ]
            : (yield* SessionPeerRoute.list(SessionSchema.ID.make(ctx.sessionID))).filter((route) => route.can_inspect)
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          const active = execution ? yield* execution.active : new Set<SessionSchema.ID>()
          const data = yield* Effect.forEach(routes.slice(0, 32), (route) =>
            Effect.gen(function* () {
              const paused = yield* database.db
                .select()
                .from(SessionExecutionPauseTable)
                .where(eq(SessionExecutionPauseTable.session_id, route.target_session_id))
                .get()
              const interruption = yield* database.db
                .select()
                .from(SessionInterruptionTable)
                .where(eq(SessionInterruptionTable.session_id, route.target_session_id))
                .orderBy(desc(SessionInterruptionTable.time_requested))
                .get()
              const messages = yield* database.db
                .select()
                .from(SessionPeerMessageTable)
                .where(eq(SessionPeerMessageTable.target_session_id, route.target_session_id))
                .orderBy(desc(SessionPeerMessageTable.time_created))
                .limit(1)
                .all()
              const currentTask = yield* database.db
                .select()
                .from(SessionTaskTable)
                .where(eq(SessionTaskTable.child_session_id, route.target_session_id))
                .orderBy(desc(SessionTaskTable.time_created))
                .get()
              const session = yield* database.db
                .select({ updated: SessionTable.time_updated })
                .from(SessionTable)
                .where(eq(SessionTable.id, route.target_session_id))
                .get()
              const since = currentTask?.time_created ?? 0
              const legacyParts = yield* database.db
                .select()
                .from(PartTable)
                .where(and(eq(PartTable.session_id, route.target_session_id), gte(PartTable.time_created, since)))
                .orderBy(desc(PartTable.time_created))
                .limit(128)
                .all()
              const canonical = yield* database.db
                .select()
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, route.target_session_id),
                    eq(SessionMessageTable.type, "assistant"),
                    gte(SessionMessageTable.time_created, since),
                  ),
                )
                .orderBy(desc(SessionMessageTable.seq))
                .limit(128)
                .all()
              const tools = [
                ...legacyParts.flatMap((part) => {
                  const data = part.data as Record<string, unknown>
                  if (data.type !== "tool" || typeof data.tool !== "string") return []
                  const state = data.state
                  if (!state || typeof state !== "object" || !("status" in state) || typeof state.status !== "string")
                    return []
                  return [
                    {
                      id: part.id,
                      name: data.tool,
                      status: state.status,
                      started_at: part.time_created,
                      cancelled: state.status === "error" && "error" in state && state.error === "Cancelled",
                    },
                  ]
                }),
                ...canonical.flatMap((row) => {
                  const decoded = Schema.decodeUnknownOption(SessionMessage.Assistant)({
                    ...row.data,
                    id: row.id,
                    type: row.type,
                  })
                  return Option.isSome(decoded)
                    ? decoded.value.content
                        .filter((part) => part.type === "tool")
                        .map((part) => ({
                          id: part.id,
                          name: part.name,
                          status: part.state.status,
                          started_at: row.time_created,
                          cancelled:
                            part.state.status === "error" &&
                            JSON.stringify(part.state.error).includes("Tool execution interrupted"),
                        }))
                    : []
                }),
              ]
              const unique = [...new Map(tools.map((tool) => [tool.id, tool])).values()]
              const owned =
                active.has(route.target_session_id) || !!SessionLegacyOwner.generation(route.target_session_id)
              const unresolved = unique.some((tool) => tool.status === "pending" || tool.status === "running")
              return {
                alias: route.alias,
                state: owned ? "running" : paused ? "interrupted" : !execution || unresolved ? "unknown" : "idle",
                recent_execution:
                  interruption?.state === "interrupted"
                    ? { status: "interrupted", actor: interruption.actor_kind, at: interruption.time_settled }
                    : interruption?.state === "completed"
                      ? { status: "completed", at: interruption.time_settled }
                      : null,
                last_message_at: messages[0]?.time_created ?? null,
                last_message_kind: messages[0]?.kind ?? null,
                last_activity_at: Math.max(session?.updated ?? 0, messages[0]?.time_created ?? 0),
                phase:
                  !owned && (!execution || unresolved)
                    ? "unknown"
                    : owned && unique.some((tool) => tool.status === "running")
                      ? "tool"
                      : "model_or_idle",
                active_tools: (owned ? unique : [])
                  .filter((tool) => tool.status === "running")
                  .slice(0, 3)
                  .map((tool) => ({
                    name: tool.name,
                    started_at: tool.started_at,
                  })),
                tool_calls: {
                  started: unique.filter((tool) => tool.status !== "pending").length,
                  completed: unique.filter((tool) => tool.status === "completed").length,
                  failed: unique.filter((tool) => tool.status === "error" && !tool.cancelled).length,
                  cancelled: unique.filter((tool) => tool.cancelled).length,
                  pending: unique.filter((tool) => tool.status === "pending" || tool.status === "running").length,
                  scope: currentTask ? "since_latest_task_admission" : "session_recent_128_records",
                  truncated: legacyParts.length === 128 || canonical.length === 128,
                },
                observation: "local_owner_and_durable_history",
              }
            }),
          )
          return receipt("Agent status", { agents: data })
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause((cause) => failure("Agent status unavailable", cause)),
        ),
    }
  }),
)

export const AgentWaitTool = Tool.define(
  "agent_wait",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    return {
      description: "Wait up to 120 seconds for an Agent reply or completion. Waiting does not stop the other Agent.",
      parameters: SessionAgentTool.Wait,
      execute: (input: { aliases?: readonly string[]; timeout_ms?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (ctx.abort.aborted) return receipt("Finished waiting", { reason: "interrupted", completed: [] })
          if (
            (input.timeout_ms !== undefined &&
              (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 120_000)) ||
            (input.aliases !== undefined &&
              (input.aliases.length < 1 ||
                input.aliases.length > 32 ||
                new Set(input.aliases).size !== input.aliases.length))
          )
            return receipt("Agent wait unavailable", { reason: "invalid_request" })
          const routes = input.aliases
            ? yield* Effect.forEach(input.aliases, (alias) =>
                SessionPeerRoute.resolve({
                  sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
                  alias,
                  capability: "interact",
                }),
              )
            : (yield* SessionPeerRoute.list(SessionSchema.ID.make(ctx.sessionID))).filter((route) => route.can_interact)
          if (routes.length > 32) return receipt("Agent wait unavailable", { reason: "too_many_targets" })
          const open = yield* SessionPeerMessage.openRequests(SessionSchema.ID.make(ctx.sessionID))
          const requestIDs = open
            .filter((row) => routes.some((route) => route.target_session_id === row.target_session_id))
            .map((row) => row.id)
          const tasks = yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.parent_session_id, SessionSchema.ID.make(ctx.sessionID)))
            .all()
          const visible = tasks.filter((task) =>
            routes.some((route) => route.target_session_id === task.child_session_id),
          )
          const takeCompletion = Effect.gen(function* () {
            for (const task of visible) yield* SessionTaskResult.record(database.db, events, task.input_id)
            if (!visible.length) return undefined
            const completed = yield* database.db
              .select()
              .from(SessionTaskResultTable)
              .where(
                inArray(
                  SessionTaskResultTable.invocation_input_id,
                  visible.map((task) => task.input_id),
                ),
              )
              .all()
            for (const result of completed) {
              const claimed = yield* database.db
                .insert(SessionPeerReceiptTable)
                .values({
                  message_id: result.notification_input_id,
                  receiver_session_id: SessionSchema.ID.make(ctx.sessionID),
                  channel: "wait",
                  time_consumed: Date.now(),
                })
                .onConflictDoNothing()
                .returning({ id: SessionPeerReceiptTable.message_id })
                .get()
              if (!claimed) continue
              const interruption =
                result.outcome === "cancelled"
                  ? yield* database.db
                      .select()
                      .from(SessionInterruptionTable)
                      .where(eq(SessionInterruptionTable.session_id, SessionSchema.ID.make(result.child_session_id)))
                      .orderBy(desc(SessionInterruptionTable.time_requested))
                      .get()
                  : undefined
              return {
                reason:
                  result.outcome === "completed"
                    ? "completed"
                    : result.outcome === "cancelled"
                      ? "interrupted"
                      : "failed",
                ...(result.outcome === "cancelled"
                  ? { actor: interruption?.state === "interrupted" ? interruption.actor_kind : "unknown" }
                  : {}),
                alias: routes.find((route) => route.target_session_id === result.child_session_id)?.alias,
                summary: result.summary.slice(0, 8192),
                truncated: result.summary.length > 8192,
                result_ref: result.result_message_id ?? result.notification_input_id,
                event_id: result.terminal_event_id,
              }
            }
            return undefined
          })
          const ready = yield* takeCompletion
          if (ready) return receipt("Agent wait", ready)
          const targets = visible
            .filter((task) => task.state !== "settled")
            .map((task) => ({
              task_id: SessionID.make(task.child_session_id),
              input_id: task.input_id,
              invocation: {
                parent_session_id: SessionID.make(task.parent_session_id),
                parent_message_id: task.parent_message_id,
                call_id: task.call_id,
              },
            }))
          if (!requestIDs.length && !targets.length)
            return receipt("Finished waiting", { reason: "timeout", timed_out: true, completed: [] })
          const timeoutMs = input.timeout_ms ?? 30_000
          const replies =
            requestIDs.length || targets.length
              ? SessionPeerWait.waitReply({
                  sessionID: SessionSchema.ID.make(ctx.sessionID),
                  requestIDs,
                  timeoutMs,
                }).pipe(Effect.map((result) => ({ kind: "reply" as const, result })))
              : undefined
          const completions = targets.length
            ? SessionTaskWait.wait({ parentSessionID: SessionSchema.ID.make(ctx.sessionID), targets, timeoutMs }).pipe(
                Effect.map((result) => ({ kind: "task" as const, result })),
              )
            : undefined
          if (!replies && !completions)
            return receipt("Finished waiting", { reason: "timeout", timed_out: true, completed: [] })
          if (!ctx.callID) return receipt("Agent wait unavailable", { reason: "invalid_operation" })
          const callID = ctx.callID
          const waitID = `${ctx.sessionID}:${ctx.callID}`
          const registered = yield* SessionAgentWaitOwner.withReceiver(ctx.sessionID)(
            Effect.gen(function* () {
              const row = yield* database.db
                .insert(SessionAgentWaitTable)
                .values({
                  id: waitID,
                  call_id: callID,
                  session_id: SessionSchema.ID.make(ctx.sessionID),
                  targets: routes.map((route) => route.target_session_id),
                  state: "active",
                  time_created: Date.now(),
                })
                .onConflictDoNothing()
                .returning({ id: SessionAgentWaitTable.id })
                .get()
              if (row) SessionAgentWaitOwner.start(waitID)
              return row
            }),
          )
          if (!registered) return receipt("Finished waiting", { reason: "already_finished", completed: [] })
          const waiting = replies && completions ? Effect.raceFirst(replies, completions) : (replies ?? completions!)
          const aborted = Effect.callback<"aborted">((resume) => {
            if (ctx.abort.aborted) return resume(Effect.succeed("aborted"))
            const handler = () => resume(Effect.succeed("aborted"))
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })
          return yield* Effect.gen(function* () {
            const result = yield* Effect.raceFirst(waiting, aborted)
            if (result === "aborted") return receipt("Finished waiting", { reason: "interrupted", completed: [] })
            if (result.kind === "task") {
              const completed = yield* takeCompletion
              if (completed) return receipt("Agent wait", completed)
            }
            return receipt(
              result.kind === "reply" && result.result.reason === "timeout" ? "Finished waiting" : "Agent wait",
              result.result,
            )
          }).pipe(
            Effect.ensuring(
              SessionAgentWaitOwner.withReceiver(ctx.sessionID)(
                database.db
                  .update(SessionAgentWaitTable)
                  .set({ state: "finished", time_finished: Date.now() })
                  .where(eq(SessionAgentWaitTable.id, waitID))
                  .run()
                  .pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => SessionAgentWaitOwner.finish(waitID)))),
              ),
            ),
          )
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(LocationServiceMap.Service, locations),
          Effect.catchCause((cause) => failure("Agent wait unavailable", cause)),
        ),
    }
  }),
)

export const AgentInterruptTool = Tool.define(
  "agent_interrupt",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Immediately interrupt a visible Agent's current execution. Its Session remains available for later interaction.",
      parameters: SessionAgentTool.Interrupt,
      execute: (input: { alias: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!ctx.callID) return receipt("Agent interrupt unavailable", { status: "invalid_operation" })
          const route = yield* SessionPeerRoute.resolve({
            sourceSessionID: SessionSchema.ID.make(ctx.sessionID),
            alias: input.alias,
            capability: "interrupt",
          })
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          const request = SessionInterruption.request({
            sessionID: route.target_session_id,
            operationID: `agent_interrupt:${ctx.messageID}:${ctx.callID}`,
            actor: { kind: "agent", id: ctx.sessionID },
          })
          const result = yield* execution
            ? request.pipe(Effect.provideService(SessionExecution.Service, execution))
            : request
          const status = result?.state ?? "unconfirmed"
          return {
            ...receipt(
              status === "interrupted"
                ? `Interrupted ${input.alias}`
                : status === "idle"
                  ? `Idle ${input.alias}`
                  : `Interrupting ${input.alias}`,
              { alias: input.alias, session_id: route.target_session_id, status, actor: "agent" },
            ),
            metadata: { targetSessionID: route.target_session_id },
          }
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.provideService(EventV2.Service, events),
          Effect.catchCause((cause) => failure("Agent interrupt unavailable", cause)),
        ),
    }
  }),
)

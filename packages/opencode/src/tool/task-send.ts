import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskDelivery } from "@opencode-ai/core/session/task-delivery"
import { AdmissionConflict } from "@opencode-ai/core/session/task"
import { SessionTask } from "@opencode-ai/schema/session-task"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Effect, Option, Schema } from "effect"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({ target: SessionTask.ExactTarget, text: Schema.String })

export const TaskSendTool = Tool.define(
  "task_send",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service
    const backend = Option.getOrElse(
      yield* Effect.serviceOption(SessionTaskCapability.Service),
      () => SessionTaskCapability.legacyTaskPromptOps,
    )
    return {
      description: "Send a steer to one active direct child Task invocation and receive its durable admission state.",
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const capability = SessionTaskCapability.evaluate(backend)
          if (
            !ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents) ||
            capability.status === "unsupported"
          )
            return { title: "Task send unsupported", output: "task_control_unsupported", metadata: {} }
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          if (!execution) return { title: "Task send unavailable", output: "task_unavailable", metadata: {} }
          if (input.target.invocation.parent_session_id !== ctx.sessionID)
            return { title: "Task target unavailable", output: "task_unknown_or_forbidden", metadata: {} }
          if (!ctx.callID || !input.text)
            return { title: "Invalid Task send", output: "task_send_invalid_request", metadata: {} }
          const receipt = yield* SessionTaskDelivery.send({
            childSessionID: input.target.task_id,
            invocationInputID: input.target.input_id,
            invocation: {
              parentSessionID: ctx.sessionID,
              parentMessageID: input.target.invocation.parent_message_id,
              callID: input.target.invocation.call_id,
            },
            operationID: `task_send:${ctx.messageID}:${ctx.callID}`,
            text: input.text,
          }).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(Database.Service, database),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return { title: "Task send receipt", output: JSON.stringify(receipt), metadata: {} }
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.succeed({
              title: "Task send unavailable",
              output:
                error instanceof SessionTaskDelivery.UnknownOrForbidden
                  ? "task_unknown_or_forbidden"
                  : error instanceof SessionTaskDelivery.NotRunning
                    ? "task_not_running"
                    : error instanceof AdmissionConflict
                      ? "task_invocation_conflict"
                      : error instanceof SessionTaskDelivery.Unavailable
                        ? "task_unavailable"
                        : "task_send_unavailable",
              metadata: {},
            })
          }),
        ),
    }
  }),
)

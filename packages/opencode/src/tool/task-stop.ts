import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Effect, Option, Schema } from "effect"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({ task_id: SessionSchema.ID })

export const TaskStopTool = Tool.define(
  "task_stop",
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
      description: "Stop the current and pending snapshot of one direct child Task with a stable tool-call identity.",
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (
            !ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents) ||
            SessionTaskCapability.evaluate(backend).status === "unsupported"
          )
            return { title: "Task stop unsupported", output: "task_control_unsupported", metadata: {} }
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          if (!execution) return { title: "Task stop unavailable", output: "task_control_unavailable", metadata: {} }
          if (!ctx.callID) return { title: "Invalid Task stop", output: "task_stop_invalid_request", metadata: {} }
          const receipt = yield* SessionTaskControl.stop({
            parentSessionID: ctx.sessionID,
            childSessionID: input.task_id,
            operationID: `task_stop:${ctx.messageID}:${ctx.callID}`,
            actor: { kind: "parent", id: ctx.sessionID },
          }).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(Database.Service, database),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return {
            title: "Task stop receipt",
            output: JSON.stringify({
              operation_id: receipt.operationID,
              data: receipt.data.map((member) => ({ input_id: member.inputID, state: member.state })),
            }),
            metadata: {},
          }
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.succeed({
              title: "Task stop unavailable",
              output:
                error instanceof SessionTaskControl.UnknownOrForbidden
                  ? "task_unknown_or_forbidden"
                  : error instanceof SessionTaskControl.Conflict
                    ? "task_invocation_conflict"
                    : "task_control_unavailable",
              metadata: {},
            })
          }),
        ),
    }
  }),
)

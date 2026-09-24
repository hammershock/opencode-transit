import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"
import { SessionTask } from "@opencode-ai/schema/session-task"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Effect, Option, Schema } from "effect"
import { Tool } from "./tool"

const Parameters = Schema.Struct({ target: SessionTask.ExactTarget })

export const TaskInterruptTool = Tool.define(
  "task_interrupt",
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
      description:
        "Request cancellation of one exact direct child Task invocation; other queued work remains eligible.",
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (
            !ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents) ||
            SessionTaskCapability.evaluate(backend).status === "unsupported"
          )
            return { title: "Task interrupt unsupported", output: "task_control_unsupported", metadata: {} }
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          if (!execution)
            return { title: "Task interrupt unavailable", output: "task_control_unavailable", metadata: {} }
          if (input.target.invocation.parent_session_id !== ctx.sessionID)
            return { title: "Task target unavailable", output: "task_unknown_or_forbidden", metadata: {} }
          const receipt = yield* SessionTaskControl.interrupt({
            childSessionID: input.target.task_id,
            inputID: input.target.input_id,
            invocation: {
              parentSessionID: ctx.sessionID,
              parentMessageID: input.target.invocation.parent_message_id,
              callID: input.target.invocation.call_id,
            },
            actor: { kind: "parent", id: ctx.sessionID },
          }).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(Database.Service, database),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return {
            title: "Task interrupt receipt",
            output: JSON.stringify({ input_id: receipt.inputID, state: receipt.state }),
            metadata: {},
          }
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.succeed({
              title: "Task interrupt unavailable",
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

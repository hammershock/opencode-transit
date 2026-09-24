import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskWait } from "@opencode-ai/core/session/task-wait"
import { SessionTask } from "@opencode-ai/schema/session-task"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Effect, Option } from "effect"
import { Tool } from "./tool"

export const TaskWaitTool = Tool.define(
  "task_wait",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    const backend = Option.getOrElse(
      yield* Effect.serviceOption(SessionTaskCapability.Service),
      () => SessionTaskCapability.legacyTaskPromptOps,
    )
    return {
      description:
        "Wait for exact direct-child Task invocations or new parent user input without cancelling child work.",
      parameters: SessionTask.WaitRequest,
      execute: (input: typeof SessionTask.WaitRequest.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (
            !ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents) ||
            SessionTaskCapability.evaluate(backend).status === "unsupported"
          )
            return { title: "Task wait unsupported", output: "task_control_unsupported", metadata: {} }
          const cancelled = { title: "Task wait cancelled", output: "task_wait_cancelled", metadata: {} }
          if (ctx.abort.aborted) return cancelled
          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })
          const result = yield* Effect.raceFirst(
            SessionTaskWait.wait({
              parentSessionID: ctx.sessionID,
              targets: input.targets,
              until: input.until,
              timeoutMs: input.timeout_ms,
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(LocationServiceMap.Service, locations),
              Effect.map((receipt) => ({ kind: "receipt" as const, receipt })),
            ),
            abort.pipe(Effect.as({ kind: "aborted" as const })),
          )
          if (result.kind === "aborted") return cancelled
          return { title: "Task wait", output: JSON.stringify(result.receipt), metadata: {} }
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.succeed({
              title: "Task wait unavailable",
              output:
                error instanceof SessionTaskWait.InvalidRequest
                  ? "task_wait_invalid_request"
                  : error instanceof SessionTaskWait.UnknownOrForbidden
                    ? "task_unknown_or_forbidden"
                    : "task_wait_unavailable",
              metadata: {},
            })
          }),
        ),
    }
  }),
)

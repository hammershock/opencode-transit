import { Database } from "@opencode-ai/core/database/database"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskView } from "@opencode-ai/core/session/task-view"
import { SessionTask } from "@opencode-ai/schema/session-task"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Effect, Option } from "effect"
import { Tool } from "./tool"

export const TaskStatusTool = Tool.define(
  "task_status",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const locations = yield* LocationServiceMap.Service
    const backend = Option.getOrElse(
      yield* Effect.serviceOption(SessionTaskCapability.Service),
      () => SessionTaskCapability.legacyTaskPromptOps,
    )
    return {
      description: "Read the status of direct child tasks without waking or changing them.",
      parameters: SessionTask.StatusRequest,
      execute: (input: typeof SessionTask.StatusRequest.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents))
            return {
              title: "Task status unsupported",
              output: "task_control_unsupported: experimental switch disabled",
              metadata: {},
            }
          // This tool is advertised only with a complete control backend. A stale
          // catalog or direct invocation must obey the same capability boundary.
          const capability = SessionTaskCapability.evaluate(backend)
          if (capability.status === "unsupported")
            return {
              title: "Task status unsupported",
              output: `task_control_unsupported: ${capability.missing.join(", ")}`,
              metadata: {},
            }
          if (
            (input.target && input.targets) ||
            (input.targets && (input.targets.length === 0 || input.targets.length > 32 || input.cursor)) ||
            (input.limit !== undefined && (input.limit < 1 || input.limit > 32)) ||
            (input.target?.invocation && input.cursor)
          )
            return { title: "Invalid Task status request", output: "task_status_invalid_request", metadata: {} }
          const page = input.targets
            ? {
                data: yield* Effect.forEach(input.targets, (target) =>
                  SessionTaskView.read(database, {
                    parentSessionID: ctx.sessionID,
                    childSessionID: target.task_id,
                    invocation: target.invocation,
                    includeResults: input.include_results,
                  }),
                ),
              }
            : input.target?.invocation
              ? {
                  data: [
                    yield* SessionTaskView.read(database, {
                      parentSessionID: ctx.sessionID,
                      childSessionID: input.target.task_id,
                      invocation: input.target.invocation,
                      includeResults: input.include_results,
                    }),
                  ],
                }
              : input.target
                ? yield* SessionTaskView.invocations(database, {
                    parentSessionID: ctx.sessionID,
                    childSessionID: input.target.task_id,
                    cursor: input.cursor,
                    limit: input.limit,
                    includeResults: input.include_results,
                  })
                : yield* SessionTaskView.children(database, {
                    parentSessionID: ctx.sessionID,
                    cursor: input.cursor,
                    limit: input.limit,
                    includeResults: input.include_results,
                  })
          const data = yield* Effect.forEach(page.data, (view) =>
            SessionTaskView.withObservedPhase(database, view, locations),
          )
          return { title: "Task status", output: JSON.stringify({ ...page, data }), metadata: {} }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              title: "Task status unavailable",
              output:
                error instanceof SessionTaskView.InvalidCursor
                  ? "task_status_invalid_cursor"
                  : "task_target_unavailable",
              metadata: {},
            }),
          ),
          Effect.orDie,
        ),
    }
  }),
)

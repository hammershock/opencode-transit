import { ToolFailure } from "@opencode-ai/llm"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry as CoreToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Effect, Exit, Layer, Schema } from "effect"
import { Parameters } from "./task"
import { MessageID } from "@/session/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@/project/project"
import { eq } from "drizzle-orm"
import { SessionTask } from "@opencode-ai/schema/session-task"
import { Parameters as TaskSendParameters } from "./task-send"
import { Parameters as TaskReconcileParameters } from "./task-reconcile"
import { Parameters as TaskInterruptParameters } from "./task-interrupt"
import { Parameters as TaskStopParameters } from "./task-stop"
import { Config } from "@opencode-ai/core/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"

/** Register the existing durable V2 Task adapter in the canonical V2 tool catalog. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const controlsEnabled = ConfigExperimental.backgroundSubagents(
      {
        experimental: (yield* config.entries())
          .filter((entry): entry is Config.Document => entry.type === "document")
          .findLast((entry) => entry.info.experimental?.background_subagents !== undefined)
          ?.info.experimental,
      },
      flags.experimentalBackgroundSubagents,
    )
    const execute = (name: string, input: unknown, context: Tool.Context, resources: readonly string[] = []) =>
      Effect.gen(function* () {
        const source = {
          type: "tool" as const,
          messageID: context.assistantMessageID,
          callID: context.toolCallID,
        }
        const assert = (action: string, patterns: readonly string[]) =>
          permission.assert({
            action,
            resources: patterns,
            sessionID: context.sessionID,
            agent: context.agent,
            source,
          })
        yield* assert(name, resources)
        const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
        const { ToolRegistry } = yield* Effect.promise(() => import("./registry"))
        const result = yield* Effect.promise((signal) =>
          AppRuntime.runPromiseExit(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const owner = yield* db
                .select({ session: SessionTable, project: ProjectTable })
                .from(SessionTable)
                .innerJoin(ProjectTable, eq(ProjectTable.id, SessionTable.project_id))
                .where(eq(SessionTable.id, context.sessionID))
                .get()
              if (!owner) return yield* Effect.fail(new ToolFailure({ message: "Task parent unavailable" }))
              return yield* ToolRegistry.Service.use((registry) =>
                Effect.gen(function* () {
                  const definition = (yield* registry.all()).find((item) => item.id === name)
                  if (!definition) return yield* Effect.fail(new ToolFailure({ message: "Task control unsupported" }))
                  return yield* definition.execute(input, {
                    sessionID: context.sessionID,
                    messageID: MessageID.make(context.assistantMessageID),
                    agent: context.agent,
                    callID: context.toolCallID,
                    abort: signal,
                    messages: [],
                    metadata: () => Effect.void,
                    ask: (request) => assert(request.permission, request.patterns).pipe(Effect.orDie),
                  })
                }),
              ).pipe(
                Effect.provideService(InstanceRef, {
                  directory: owner.session.directory,
                  worktree: owner.project.worktree,
                  project: Project.fromRow(owner.project),
                  ...(owner.session.target ? { target: owner.session.target } : {}),
                  ...(owner.session.workspace_id ? { workspaceID: owner.session.workspace_id } : {}),
                }),
                Effect.provideService(WorkspaceRef, owner.session.workspace_id ?? undefined),
              )
            }),
            { signal },
          ),
        ).pipe(Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value))))
        return result.output
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure ? error : new ToolFailure({ message: String(error), error }),
        ),
      )
    yield* tools
      .register({
        task: Tool.make({
          description:
            "Launch or resume a subagent. Set background=true to continue while the child runs; the parent receives one completion notification.",
          input: Parameters,
          output: Schema.String,
          execute: (input, context) => execute("task", input, context, [input.subagent_type]),
        }),
        ...(controlsEnabled ? { task_status: Tool.make({
          description: "Read direct child Task state and invocation history without waking the child.",
          input: SessionTask.StatusRequest,
          output: Schema.String,
          execute: (input, context) => execute("task_status", input, context),
        }),
        task_send: Tool.make({
          description: "Steer one exact running direct child Task and return its durable receipt.",
          input: TaskSendParameters,
          output: Schema.String,
          execute: (input, context) => execute("task_send", input, context),
        }),
        task_reconcile: Tool.make({
          description: "Explicitly resume or cancel one frozen direct child Task input.",
          input: TaskReconcileParameters,
          output: Schema.String,
          execute: (input, context) => execute("task_reconcile", input, context),
        }),
        task_wait: Tool.make({
          description: "Wait for exact direct child invocations or parent input without cancelling child work.",
          input: SessionTask.WaitRequest,
          output: Schema.String,
          execute: (input, context) => execute("task_wait", input, context),
        }),
        task_interrupt: Tool.make({
          description: "Interrupt one exact direct child Task invocation.",
          input: TaskInterruptParameters,
          output: Schema.String,
          execute: (input, context) => execute("task_interrupt", input, context),
        }),
        task_stop: Tool.make({
          description: "Stop the current and pending snapshot of one direct child Task with stable call identity.",
          input: TaskStopParameters,
          output: Schema.String,
          execute: (input, context) => execute("task_stop", input, context),
        }) } : {}),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task-v2",
  layer,
  deps: [CoreToolRegistry.toolsNode, PermissionV2.node, Config.node, RuntimeFlags.node],
})

export * as TaskV2Tool from "./task-v2"

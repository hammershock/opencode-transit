import { ToolFailure } from "@opencode-ai/llm"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Effect, Layer, Schema } from "effect"
import DESCRIPTION from "./slash-command.txt"
import { Parameters, runSlashCommand } from "./slash-command"

const Result = Schema.Struct({
  status: Schema.Literals(["completed", "cancelled", "failed", "unknown"]),
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.optional(Schema.String),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const targets = yield* TargetRegistry.Service
    const environment = yield* LocationEnvironment.Service
    yield* tools.register({
      slash_command: Tool.make({
        description: DESCRIPTION,
        input: Parameters,
        output: Result,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* sessions.get(context.sessionID)
            if (!session) return yield* Effect.fail(new ToolFailure({ message: "Session unavailable" }))
            if (session.parentID)
              return yield* Effect.fail(new ToolFailure({ message: "Slash commands are only available to the primary session" }))
            return yield* runSlashCommand(input.command, targets, environment, session.location.target)
          }),
        toModelOutput: ({ output }) => [{
          type: "text",
          text: [
            `status: ${output.status}`,
            ...(output.code ? [`code: ${output.code}`] : []),
            ...(output.stdout ? [output.stdout] : []),
            ...(output.stderr ? [`stderr: ${output.stderr}`] : []),
          ].join("\n"),
        }],
      }),
    }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/slash-command-v2",
  layer,
  deps: [ToolRegistry.toolsNode, SessionStore.node, TargetRegistry.node, LocationEnvironment.node],
})

export * as SlashCommandV2Tool from "./slash-command-v2"

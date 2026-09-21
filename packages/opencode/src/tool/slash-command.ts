import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { Session } from "@/session/session"
import DESCRIPTION from "./slash-command.txt"

export const Parameters = Schema.Struct({
  command: Schema.String,
})

export type CommandStatus = "completed" | "cancelled" | "failed" | "unknown"

export type CommandResult = {
  status: CommandStatus
  stdout: string
  stderr: string
  code?: string
}

type Metadata = CommandResult & { command: string }

function fail(code: string, message: string): CommandResult {
  return { status: "failed", stdout: "", stderr: message, code }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function targetList(snapshot: TargetRegistry.Snapshot): CommandResult {
  const columns = ["selector", "name", "description", "status"] as const
  const rows: string[][] = [
    [...columns],
    ["local", "local", "Local execution target", "available"],
    ...snapshot.targets.map((target) => [
      target.id,
      target.name,
      target.description ?? "",
      target.health?.status ?? "unknown",
    ]),
  ]
  const widths = columns.map((_, column) => Math.max(...rows.map((row) => Bun.stringWidth(row[column] ?? ""))))
  const stdout = rows
    .map((row) =>
      columns
        .map((_, column) => (row[column] ?? "").padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
  return { status: "completed", stdout, stderr: "" }
}

export const SlashCommandTool = Tool.define<
  typeof Parameters,
  Metadata,
  TargetRegistry.Service | Session.Service
>(
  "slash_command",
  Effect.gen(function* () {
    const targetRegistry = yield* TargetRegistry.Service
    const session = yield* Session.Service

    const execute = (command: string): Effect.Effect<CommandResult> =>
      Effect.gen(function* () {
        const tokens = command.trim().split(/\s+/)
        if (tokens[0] === "/target" && tokens[1] === "list") {
          return yield* Effect.promise(() => targetRegistry.load()).pipe(
            Effect.map((snapshot) => targetList(snapshot)),
            Effect.catch((error) => Effect.succeed(fail("target_list_failed", messageOf(error)))),
          )
        }
        if (tokens[0] === "/env" && tokens[1] === "reload") {
          const environment = yield* Effect.serviceOption(LocationEnvironment.Service)
          if (Option.isNone(environment)) {
            return fail("headless_unavailable", "Environment service is unavailable for this session")
          }
          return yield* environment.value.reload().pipe(
            Effect.map(
              (snapshot): CommandResult => ({
                status: "completed",
                stdout: `Environment generation ${snapshot.generation} loaded`,
                stderr: "",
              }),
            ),
            Effect.catch((error) => Effect.succeed(fail("reload_failed", messageOf(error)))),
          )
        }
        return fail("unknown_command", `Unknown or unavailable slash command: ${command}`)
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.parentID) {
            const denied = fail("subagent_forbidden", "Slash commands are only available to the primary session")
            return { title: params.command, output: denied.stderr, metadata: { ...denied, command: params.command } }
          }
          const result = yield* execute(params.command)
          return {
            title: params.command,
            output: result.stdout || result.stderr,
            metadata: { ...result, command: params.command },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { Location } from "@opencode-ai/core/location"
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

export function targetList(snapshot: TargetRegistry.Snapshot, current?: Location.Target): CommandResult {
  const columns = ["selector", "name", "description", "status"] as const
  const currentSelector = current ? (current.type === "rexd" ? current.targetID : "local") : undefined
  const mark = (selector: string) => (currentSelector && selector === currentSelector ? `*${selector}` : selector)
  const rows: string[][] = [
    [...columns],
    [mark("local"), "local", "Local execution target", "available"],
    ...snapshot.targets.map((target) => [
      mark(target.id),
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

export function runSlashCommand(
  command: string,
  targetRegistry: TargetRegistry.Interface,
  environment?: LocationEnvironment.Interface,
  current?: Location.Target,
): Effect.Effect<CommandResult> {
  return Effect.gen(function* () {
    const tokens = command.trim().split(/\s+/)
    if (tokens[0] === "/target" && tokens[1] === "list") {
      return yield* Effect.promise(() => targetRegistry.load()).pipe(
        Effect.map((snapshot) => targetList(snapshot, current)),
        Effect.catch((error) => Effect.succeed(fail("target_list_failed", messageOf(error)))),
      )
    }
    if (tokens[0] === "/env" && tokens[1] === "reload") {
      if (!environment) return fail("headless_unavailable", "Environment service is unavailable for this session")
      return yield* environment.reload().pipe(
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
}

export const SlashCommandTool = Tool.define<typeof Parameters, Metadata, TargetRegistry.Service | Session.Service>(
  "slash_command",
  Effect.gen(function* () {
    const targetRegistry = yield* TargetRegistry.Service
    const session = yield* Session.Service

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
          const environment = yield* Effect.serviceOption(LocationEnvironment.Service)
          const result = yield* runSlashCommand(
            params.command,
            targetRegistry,
            Option.getOrUndefined(environment),
            info?.target,
          )
          return {
            title: params.command,
            output: result.stdout || result.stderr,
            metadata: { ...result, command: params.command },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

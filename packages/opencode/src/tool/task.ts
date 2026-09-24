import * as Tool from "./tool"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Subagent } from "../agent/subagent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { SessionPolicyAccess } from "@opencode-ai/core/session/policy-access"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskOwner } from "@opencode-ai/core/session/task-owner"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { eq } from "drizzle-orm"
import path from "path"
import { Location } from "@opencode-ai/core/location"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Permission } from "@opencode-ai/schema/permission"
import type { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceStore } from "@/project/instance-store"
import { ExecutionPolicy } from "@opencode-ai/core/permission/policy"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { mapAgentV2 } from "@/agent/location-agent"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  cancelRunner(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string, sessionID?: SessionID): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
export class CatalogChangedError extends Error {
  constructor() {
    super("catalog_changed: the subagent catalog changed; refresh the tool catalog and retry")
  }
}
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  target: Schema.optional(Schema.String).annotate({
    description:
      'Optional execution target for the child session: "local" or a stable target ID (or a unique exact display name). Omit to keep the parent target.',
  }),
  directory: Schema.optional(Schema.String).annotate({
    description:
      "Optional absolute directory on the selected target. Omit to inherit the parent directory for the same target, or use the target's default directory when switching targets.",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const MAX_LOCATION_FIELD = 256

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `&#${char.charCodeAt(0)};`)
}

function clipLocation(value: string): string {
  return value.length <= MAX_LOCATION_FIELD ? value : value.slice(0, MAX_LOCATION_FIELD) + "…"
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  location?: { id: string; name: string; directory: string }
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.location
      ? [
          `<target id="${escapeXmlAttribute(clipLocation(input.location.id))}" name="${escapeXmlAttribute(clipLocation(input.location.name))}" directory="${escapeXmlAttribute(clipLocation(input.location.directory))}" />`,
        ]
      : []),
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const PATH_ACTIONS = new Set(["read", "edit", "external_directory"])

export class TaskPlacementError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.code = code
    this.name = "TaskPlacementError"
  }
}

type ResolvedTarget = {
  readonly target: Location.Target
  readonly name: string
  readonly definition?: TargetRegistry.Definition
}

type PlannedDestination = {
  readonly target: Location.Target
  readonly directory: string
  readonly targetName: string
  readonly targetID: string
  readonly lastKnownTargetName?: string
  readonly changedPlacement: boolean
  readonly crossTarget: boolean
}

export function resolveTargetSelector(selector: string, snapshot: TargetRegistry.Snapshot): ResolvedTarget {
  if (selector === "local") return { target: { type: "local" }, name: "local" }
  const byID = snapshot.targets.find((target) => target.id === selector)
  if (byID) return { target: { type: "rexd", targetID: byID.id }, name: byID.name, definition: byID }
  const byName = snapshot.targets.filter((target) => target.name === selector)
  if (byName.length > 1)
    throw new TaskPlacementError(
      "target_name_conflict",
      `Multiple targets are named "${selector}"; pass the stable target ID instead`,
    )
  if (byName.length === 1) {
    const target = byName[0]
    return { target: { type: "rexd", targetID: target.id }, name: target.name, definition: target }
  }
  throw new TaskPlacementError(
    "unknown_target",
    `Unknown target "${selector}"; use "local", a registered target ID, or a unique target name`,
  )
}

export function sameTarget(a: Location.Target | undefined, b: Location.Target): boolean {
  const left = a ?? { type: "local" }
  if (left.type === "local") return b.type === "local"
  return b.type === "rexd" && b.targetID === left.targetID
}

function validateDirectory(directory: string, target: Location.Target) {
  if (directory.trim() === "") throw new TaskPlacementError("invalid_directory", "Directory must be an absolute path")
  const platform = target.type === "rexd" ? path.posix : path
  if (!platform.isAbsolute(directory))
    throw new TaskPlacementError("invalid_directory", `Directory must be an absolute path (received "${directory}")`)
  if (directory.startsWith("~") || directory.includes("$"))
    throw new TaskPlacementError(
      "invalid_directory",
      `Directory must be an absolute path without ~ or environment expansion (received "${directory}")`,
    )
}

function targetSelectorFor(target: Location.Target, snapshot: TargetRegistry.Snapshot): ResolvedTarget {
  if (target.type === "local") return { target, name: "local" }
  const definition = snapshot.targets.find((item) => item.id === target.targetID)
  if (!definition)
    throw new TaskPlacementError("target_removed", `Target "${target.targetID}" is no longer in the registry`)
  return { target, name: definition.name, definition }
}

function requireRegistryValid(snapshot: TargetRegistry.Snapshot) {
  if (!snapshot.valid)
    throw new TaskPlacementError(
      "invalid_registry",
      `Target registry is invalid: ${snapshot.diagnostics
        .filter((item) => item.severity === "error")
        .map((item) => `${item.path}: ${item.message}`)
        .join("; ")}`,
    )
}

export function planDestination(input: {
  targetParam: string | undefined
  directoryParam: string | undefined
  parent: Session.Info
  snapshot: TargetRegistry.Snapshot
}): PlannedDestination {
  requireRegistryValid(input.snapshot)
  const parentTarget = input.parent.target ?? { type: "local" }
  const resolved =
    input.targetParam === undefined
      ? targetSelectorFor(parentTarget, input.snapshot)
      : resolveTargetSelector(input.targetParam, input.snapshot)
  const crossTarget = !sameTarget(parentTarget, resolved.target)
  const targetID = resolved.target.type === "rexd" ? resolved.target.targetID : "local"

  if (input.directoryParam !== undefined) {
    validateDirectory(input.directoryParam, resolved.target)
    return {
      target: resolved.target,
      directory: input.directoryParam,
      targetName: resolved.name,
      targetID,
      lastKnownTargetName: resolved.target.type === "rexd" ? resolved.name : undefined,
      changedPlacement: crossTarget || input.directoryParam !== input.parent.directory,
      crossTarget,
    }
  }

  if (!crossTarget) {
    return {
      target: parentTarget,
      directory: input.parent.directory,
      targetName: input.parent.lastKnownTargetName ?? resolved.name,
      targetID,
      lastKnownTargetName: input.parent.lastKnownTargetName,
      changedPlacement: false,
      crossTarget: false,
    }
  }

  if (resolved.target.type === "rexd") {
    if (!resolved.definition?.defaultDirectory)
      throw new TaskPlacementError(
        "default_directory_required",
        `Target "${resolved.name}" has no defaultDirectory; pass an explicit absolute directory`,
      )
    return {
      target: resolved.target,
      directory: resolved.definition.defaultDirectory,
      targetName: resolved.name,
      targetID,
      lastKnownTargetName: resolved.name,
      changedPlacement: true,
      crossTarget: true,
    }
  }

  throw new TaskPlacementError(
    "directory_required",
    "Placing a child on the local target requires an explicit absolute directory",
  )
}

export function planResumeDestination(input: {
  targetParam: string | undefined
  directoryParam: string | undefined
  parent: Session.Info
  existing: Session.Info
  snapshot: TargetRegistry.Snapshot
}): PlannedDestination {
  requireRegistryValid(input.snapshot)
  const parentTarget = input.parent.target ?? { type: "local" }
  const existingTarget = input.existing.target ?? { type: "local" }
  if (existingTarget.type === "rexd" && !input.snapshot.targets.some((item) => item.id === existingTarget.targetID))
    throw new TaskPlacementError(
      "target_removed",
      `Child target "${existingTarget.targetID}" is no longer in the registry`,
    )
  if (input.targetParam !== undefined) {
    const resolved = resolveTargetSelector(input.targetParam, input.snapshot)
    if (!sameTarget(existingTarget, resolved.target))
      throw new TaskPlacementError("task_location_mismatch", "task_id target does not match the stored child target")
  }
  if (input.directoryParam !== undefined) {
    if (input.directoryParam !== input.existing.directory)
      throw new TaskPlacementError(
        "task_location_mismatch",
        "task_id directory does not match the stored child directory",
      )
  }
  const crossTarget = !sameTarget(parentTarget, existingTarget)
  const targetID = existingTarget.type === "rexd" ? existingTarget.targetID : "local"
  return {
    target: existingTarget,
    directory: input.existing.directory,
    targetName:
      input.existing.lastKnownTargetName ?? (existingTarget.type === "rexd" ? existingTarget.targetID : "local"),
    targetID,
    lastKnownTargetName: input.existing.lastKnownTargetName,
    changedPlacement: crossTarget || input.existing.directory !== input.parent.directory,
    crossTarget,
  }
}

export function preflightDestination(input: {
  planned: PlannedDestination
  denyRules: readonly Permission.Rule[]
  registry: TargetRegistry.Interface
  fs: FSUtil.Interface
  expectedRevision: string
}): Effect.Effect<void, TaskPlacementError> {
  return Effect.gen(function* () {
    const planned = input.planned
    if (planned.crossTarget) {
      const deny = findParentPathDeny(input.denyRules)
      if (deny)
        return yield* Effect.fail(
          new TaskPlacementError(
            "parent_path_deny_unsupported",
            `Parent path-specific deny cannot be translated across targets (${deny})`,
          ),
        )
    }
    const target = planned.target
    if (target.type === "rexd") {
      if (planned.changedPlacement) {
        const result = yield* Effect.tryPromise({
          try: () => input.registry.prepare(target.targetID, planned.directory),
          catch: (error) =>
            new TaskPlacementError(
              "target_unavailable",
              `Target "${planned.targetName}" is unavailable at "${planned.directory}" (${error instanceof Error ? error.message : String(error)})`,
            ),
        })
        if (result.status !== "ready")
          return yield* Effect.fail(
            new TaskPlacementError(
              "target_unavailable",
              `Target "${planned.targetName}" is unavailable at "${planned.directory}" (${result.stage}: ${result.message})`,
            ),
          )
      }
      // Re-confirm the target identity and registry revision are unchanged after any
      // probe, so a same-ID definition change (host/roots) fails closed (RFC-0018 §1.4).
      yield* revalidateRegistryTarget(input.registry, target.targetID, input.expectedRevision)
      return yield* Effect.void
    }
    if (!planned.changedPlacement) return yield* Effect.void
    const isDir = yield* input.fs.isDir(planned.directory)
    if (!isDir)
      return yield* Effect.fail(
        new TaskPlacementError(
          "directory_unavailable",
          `Directory does not exist or is not accessible: ${planned.directory}`,
        ),
      )
  })
}

function revalidateRegistryTarget(
  registry: TargetRegistry.Interface,
  targetID: Location.TargetID,
  expectedRevision: string,
): Effect.Effect<void, TaskPlacementError> {
  return Effect.gen(function* () {
    const snapshot = yield* Effect.tryPromise({
      try: () => registry.load(),
      catch: () => new TaskPlacementError("invalid_registry", "Could not re-read the target registry during preflight"),
    })
    if (!snapshot.valid)
      return yield* Effect.fail(
        new TaskPlacementError("invalid_registry", "Target registry became invalid during preflight"),
      )
    if (snapshot.revision !== expectedRevision)
      return yield* Effect.fail(
        new TaskPlacementError("target_registry_changed", "Target registry changed during preflight"),
      )
    if (!snapshot.targets.some((item) => item.id === targetID))
      return yield* Effect.fail(
        new TaskPlacementError("target_removed", `Target "${targetID}" was removed during preflight`),
      )
  })
}

export function findParentPathDeny(rules: readonly Permission.Rule[]): string | undefined {
  const rule = rules.find((rule) => rule.effect === "deny" && isPathSpecific(rule))
  return rule ? `${rule.action} ${rule.resource}` : undefined
}

/** Map a location-scoped Core AgentV2 definition to the narrow legacy Agent.Info shape the Task tool consumes. */

function isPathSpecific(rule: { action: string; resource: string }): boolean {
  return PATH_ACTIONS.has(rule.action) && rule.resource !== "*"
}

export function parentDenyRules(input: {
  rules: readonly Permission.Rule[]
  boundary?: SessionPolicy.Boundary
}): Permission.Rule[] {
  return [...(input.boundary ?? []).flat(), ...input.rules].filter((rule) => rule.effect === "deny")
}

/** Cross-target: drop parent-machine path grants (allow/ask) but keep denies and non-path rules. */
export function filterCrossTargetPermission(input: {
  permission: PermissionV1.Ruleset
  boundary: SessionPolicy.Boundary
}): { permission: PermissionV1.Ruleset; boundary: SessionPolicy.Boundary } {
  return {
    permission: input.permission.filter(
      (rule) => rule.action === "deny" || !isPathSpecific({ action: rule.permission, resource: rule.pattern }),
    ),
    boundary: input.boundary.map((ruleset) =>
      ruleset.filter((rule) => rule.effect === "deny" || !isPathSpecific(rule)),
    ),
  }
}

/** Resume must reflect the parent's current non-path hard denies; a newly introduced deny fails before prompt. */
export function checkResumeDenies(existing: Session.Info, denyRules: readonly Permission.Rule[]): void {
  const stored = new Set<string>()
  for (const rule of existing.permission ?? []) {
    if (rule.action === "deny") stored.add(`${rule.permission}\u0000${rule.pattern}`)
  }
  for (const rule of (existing.permissionBoundary ?? []).flat()) {
    if (rule.effect === "deny") stored.add(`${rule.action}\u0000${rule.resource}`)
  }
  for (const deny of denyRules) {
    if (isPathSpecific(deny)) continue
    if (!stored.has(`${deny.action}\u0000${deny.resource}`))
      throw new TaskPlacementError(
        "task_access_changed",
        `Parent deny "${deny.action} ${deny.resource}" is not reflected in the existing child; resume requires current authorization`,
      )
  }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const subagents = Option.getOrUndefined(yield* Effect.serviceOption(Subagent.Service))
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const policies = yield* SessionPolicyAccess.Service
    const registry = yield* TargetRegistry.Service
    const fs = yield* FSUtil.Service
    const locations = yield* LocationServiceMap.Service
    const locationAccess = yield* SessionLocationAccess.Service

    const resolveParentPolicy = Effect.fn("TaskTool.resolveParentPolicy")(function* (
      sessionID: SessionID,
      agentID: string,
    ) {
      const location = yield* locationAccess.require(sessionID).pipe(Effect.orDie)
      return yield* Effect.gen(function* () {
        const policy = yield* ExecutionPolicy.Service
        return yield* policy.resolve(sessionID, agentID)
      }).pipe(Effect.provide(locations.get(location)), Effect.orDie)
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents)) {
        return yield* Effect.fail(
          new Error(
            "Background subagents are disabled. Enable experimental.background_subagents in config or the experimental features menu.",
          ),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      const parentPolicy = yield* policies.inspect(ctx.sessionID).pipe(Effect.orDie)
      const catalog = subagents
        ? yield* subagents.resolve({
            parentAgentID: ctx.agent,
            sessionID: ctx.sessionID,
            includeInactive: true,
          })
        : undefined
      const expectedRevision = ctx.extra?.subagentCatalogRevision
      if (catalog && typeof expectedRevision === "string" && expectedRevision !== catalog.revision) {
        return yield* Effect.fail(new CatalogChangedError())
      }
      const direct = catalog?.entries.find((item) => item.id === params.subagent_type)
      const aliases = catalog?.entries.filter((item) => item.name === params.subagent_type) ?? []
      const entry = direct ?? (aliases.length === 1 ? aliases[0] : undefined)
      if (catalog && (!entry || entry.effective !== "active")) {
        return yield* Effect.fail(new Error(`Subagent unavailable: ${params.subagent_type}`))
      }
      const subagentID = entry?.id ?? params.subagent_type
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck && (!catalog || entry?.approvalRequired)) {
        yield* ctx.ask({
          permission: id,
          patterns: [subagentID],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: subagentID,
          },
        })
      }

      const next = yield* agent.get(subagentID)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const childAgentID = next.id ?? next.name
      const effectivePolicy = yield* resolveParentPolicy(ctx.sessionID, ctx.agent)
      const effectiveDenyRules = parentDenyRules({ rules: effectivePolicy.rules, boundary: effectivePolicy.ceilings })
      const sessionDenyRules = parentDenyRules({ rules: parentPolicy.rules, boundary: parent.permissionBoundary })
      const snapshot = yield* Effect.tryPromise({
        try: () => registry.load(),
        catch: (error) =>
          new TaskPlacementError("invalid_registry", `Target registry is unavailable: ${String(error)}`),
      })

      let resumed: Session.Info | undefined = undefined
      if (params.task_id) {
        const taskID = SessionID.make(params.task_id)
        const existing = yield* sessions.get(taskID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!existing)
          return yield* Effect.fail(
            new TaskPlacementError("task_not_found", `task_id "${params.task_id}" does not exist`),
          )
        if (existing.parentID !== ctx.sessionID)
          return yield* Effect.fail(
            new TaskPlacementError("task_foreign", `task_id "${params.task_id}" belongs to another session`),
          )
        if (existing.agent !== childAgentID)
          return yield* Effect.fail(
            new TaskPlacementError(
              "task_agent_mismatch",
              `task_id "${params.task_id}" belongs to agent "${existing.agent}"`,
            ),
          )
        resumed = existing
      }

      const planned = yield* Effect.try({
        try: () =>
          resumed
            ? planResumeDestination({
                targetParam: params.target,
                directoryParam: params.directory,
                parent,
                existing: resumed,
                snapshot,
              })
            : planDestination({ targetParam: params.target, directoryParam: params.directory, parent, snapshot }),
        catch: (error) =>
          error instanceof TaskPlacementError ? error : new TaskPlacementError("internal_error", String(error)),
      })

      yield* preflightDestination({
        planned,
        denyRules: effectiveDenyRules,
        registry,
        fs,
        expectedRevision: snapshot.revision,
      })

      if (resumed) {
        yield* Effect.try({
          try: () => checkResumeDenies(resumed, sessionDenyRules),
          catch: (error) =>
            error instanceof TaskPlacementError ? error : new TaskPlacementError("internal_error", String(error)),
        })
      }

      // InstanceStore is resolved at execution time: the tool catalog is built
      // before the global InstanceStore layer is wired into the runtime, so
      // resolving it here (from the session-loop context) is what makes
      // changed-location placement work in production.
      const instances = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
      if (planned.changedPlacement && !instances)
        return yield* Effect.fail(
          new Error("InstanceStore is unavailable; cannot place a child at a different location"),
        )
      const destinationInput = {
        directory: planned.directory,
        ...(planned.target.type === "rexd" ? { target: planned.target } : {}),
      }
      const atChild = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        planned.changedPlacement && instances ? instances.provide(destinationInput, effect) : effect

      // The destination Agent definition must come from the target Location's
      // Core AgentV2 registry, never the controller's legacy Agent catalog.
      const destinationRef = Location.Ref.make({
        target: planned.target,
        directory: AbsolutePath.make(planned.directory),
      })
      const destAgent = planned.changedPlacement
        ? yield* Effect.gen(function* () {
            const plugin = yield* PluginV2.Service
            yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
            const agents = yield* AgentV2.Service
            const info = yield* agents.resolve(AgentV2.ID.make(subagentID))
            return info ? mapAgentV2(info) : undefined
          }).pipe(Effect.provide(locations.get(destinationRef)), Effect.orDie)
        : next
      if (!destAgent)
        return yield* Effect.fail(
          new TaskPlacementError(
            "destination_agent_missing",
            `Agent "${subagentID}" is not available at the destination`,
          ),
        )
      const destAgentID = destAgent.id ?? destAgent.name
      if (destAgentID !== subagentID)
        return yield* Effect.fail(
          new TaskPlacementError(
            "destination_agent_mismatch",
            `Destination resolved a different agent "${destAgentID}" for "${subagentID}"`,
          ),
        )

      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: destAgent,
      })
      const childToolDenies = [
        ...(destAgent.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(destAgent.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const boundary = [...(parent.permissionBoundary ?? []), parentPolicy.rules]
      const childPolicy = planned.crossTarget
        ? filterCrossTargetPermission({ permission: childPermission, boundary })
        : { permission: childPermission, boundary }
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = destAgent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const previous = ctx.callID
        ? yield* SessionTask.findInvocation(database.db, { parentMessageID: ctx.messageID, callID: ctx.callID })
        : undefined
      const promptDigest = new Bun.CryptoHasher("sha256").update(params.prompt).digest("hex")
      const matchesPrior = (row: NonNullable<typeof previous>) =>
        row.parent_session_id === ctx.sessionID &&
        row.root_session_id === current.id &&
        row.description === params.description &&
        row.agent_id === childAgentID &&
        row.prompt_digest === promptDigest &&
        (!resumed || row.child_session_id === resumed.id)
      const priorReceipt = Effect.fn("TaskTool.priorReceipt")(function* (row: NonNullable<typeof previous>) {
        const sessionID = SessionID.make(row.child_session_id)
        const metadata = {
          parentSessionId: ctx.sessionID,
          invocation: {
            parentMessageID: ctx.messageID,
            callID: ctx.callID,
            childMessageID: MessageID.make(row.input_id),
          },
          sessionId: sessionID,
          model,
          target: planned.targetID,
          targetName: planned.targetName,
          directory: planned.directory,
          ...(runInBackground ? { background: true } : {}),
        }
        yield* ctx.metadata({ title: params.description, metadata })
        return {
          title: params.description,
          metadata,
          output: renderOutput({
            sessionID,
            state: row.state !== "settled" ? "running" : row.outcome === "completed" ? "completed" : "error",
            summary:
              row.state === "settled"
                ? `Invocation already settled: ${row.outcome}; result message: ${row.result_message_id ?? "none"}`
                : "Invocation already admitted; check its status before sending another call",
            text: "This exact Task invocation was already admitted. It was not started again.",
            location: { id: planned.targetID, name: planned.targetName, directory: planned.directory },
          }),
        }
      })
      if (previous) {
        if (!matchesPrior(previous)) return yield* Effect.fail(new SessionTask.AdmissionConflict())
        return yield* priorReceipt(previous)
      }
      const childMessageID = MessageID.ascending()
      const childSessionID = resumed?.id ?? SessionID.descending()
      const locationRevision = resumed
        ? ((yield* database.db
            .select({ revision: SessionTable.location_revision })
            .from(SessionTable)
            .where(eq(SessionTable.id, resumed.id))
            .get()
            .pipe(Effect.orDie))?.revision ?? 0)
        : 0
      const admission = ctx.callID
        ? {
            inputID: childMessageID,
            rootSessionID: current.id,
            parentSessionID: ctx.sessionID,
            parentMessageID: ctx.messageID,
            callID: ctx.callID,
            promptDigest,
            childSessionID,
            description: params.description,
            agentID: childAgentID,
            locationRevision,
            backend: "legacy" as const,
          }
        : undefined
      // Admission must publish the resumable child identity before cancellation can interrupt this invocation.
      const admitted = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const nextSession =
            resumed ??
            (yield* SessionTask.withOwner(childSessionID)(
              atChild(
                sessions.create({
                  id: childSessionID,
                  ...(admission
                    ? { task: admission, commit: () => SessionTask.validate(database.db, admission.inputID) }
                    : {}),
                  parentID: ctx.sessionID,
                  title: params.description + ` (@${destAgent.name} subagent)`,
                  agent: childAgentID,
                  permissionBoundary: childPolicy.boundary,
                  permission: [
                    ...childPolicy.permission,
                    ...childToolDenies.filter(
                      (deny) =>
                        !childPolicy.permission.some(
                          (rule) =>
                            rule.permission === deny.permission &&
                            rule.pattern === deny.pattern &&
                            rule.action === deny.action,
                        ),
                    ),
                  ],
                  ...(planned.changedPlacement ? { metadata: { targetAgent: true } } : {}),
                  ...(planned.changedPlacement
                    ? {
                        destination: {
                          target: planned.target,
                          directory: planned.directory,
                          ...(planned.lastKnownTargetName ? { lastKnownTargetName: planned.lastKnownTargetName } : {}),
                        },
                      }
                    : {}),
                }),
              ),
            ))
          if (resumed && admission) {
            yield* SessionTask.admitExisting(
              database.db,
              events,
              admission,
              background.get(resumed.id).pipe(Effect.map((job) => job?.status === "running")),
            )
          }
          const metadata = {
            parentSessionId: ctx.sessionID,
            invocation: { parentMessageID: ctx.messageID, callID: ctx.callID, childMessageID },
            sessionId: nextSession.id,
            model,
            target: planned.targetID,
            targetName: planned.targetName,
            directory: planned.directory,
            ...(runInBackground ? { background: true } : {}),
          }
          yield* ctx.metadata({ title: params.description, metadata })
          return { nextSession, metadata }
        }).pipe(
          Effect.catchDefect((error) => {
            if (error instanceof SessionTask.AdmissionConflict && ctx.callID)
              return SessionTask.findInvocation(database.db, {
                parentMessageID: ctx.messageID,
                callID: ctx.callID,
              }).pipe(
                Effect.flatMap((row) =>
                  row && matchesPrior(row)
                    ? Effect.succeed({ prior: row })
                    : Effect.fail(new TaskPlacementError(error.code, error.message)),
                ),
              )
            if (error instanceof SessionTask.CapacityError || error instanceof SessionTask.OwnerUnknown)
              return Effect.fail(new TaskPlacementError(error.code, error.message))
            return Effect.die(error)
          }),
        ),
      )
      if ("prior" in admitted) return yield* priorReceipt(admitted.prior)
      const nextSession = admitted.nextSession
      const metadata = admitted.metadata

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const startedAt = Date.now()
      function taskFailure(state: "error" | "cancelled", detail: string) {
        return new Error(
          `Task ${state} (task_id: ${nextSession.id}, call_id: ${ctx.callID ?? "unknown"}, model: ${model.providerID}/${model.modelID}, elapsed_ms: ${Math.max(0, Date.now() - startedAt)}, phase: unknown): ${detail.slice(0, 500)}`,
        )
      }

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        let promoted = false
        let ownerLost = false
        let resultMessageID: string | undefined
        const execute = atChild(
          Effect.gen(function* () {
            if (admission) {
              yield* SessionTask.promote(database.db, events, {
                inputID: childMessageID,
                childSessionID: nextSession.id,
              })
              promoted = true
            }
            const parts = yield* ops.resolvePromptParts(params.prompt, nextSession.id)
            const result = yield* ops.prompt({
              messageID: childMessageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant: destAgent.model ? undefined : variant,
              agent: subagentID,
              parts,
            })
            resultMessageID = result.info.id
            if (result.info.role === "assistant" && result.info.error) {
              const message =
                "message" in result.info.error.data && typeof result.info.error.data.message === "string"
                  ? result.info.error.data.message
                  : result.info.error.name
              return yield* Effect.fail(taskFailure("error", message))
            }
            const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
            if (failed?.type === "tool" && failed.state.status === "error") {
              return yield* Effect.fail(taskFailure("error", failed.state.error))
            }
            return result.parts.findLast((item) => item.type === "text")?.text ?? ""
          }).pipe(
            Effect.onExit((exit) =>
              !admission || !promoted || ownerLost
                ? Effect.void
                : SessionTask.settle(database.db, events, {
                    inputID: childMessageID,
                    childSessionID: nextSession.id,
                    outcome: Exit.isSuccess(exit) ? "completed" : Exit.hasInterrupts(exit) ? "cancelled" : "failed",
                    resultMessageID,
                  }).pipe(Effect.asVoid),
            ),
          ),
        )
        if (!admission || database.filename === ":memory:") return yield* execute
        return yield* SessionTaskOwner.withLease(
          database,
          { childSessionID: nextSession.id, inputID: childMessageID, onLost: () => (ownerLost = true) },
          execute,
        )
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                  location: { id: planned.targetID, name: planned.targetName, directory: planned.directory },
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
            location: { id: planned.targetID, name: planned.targetName, directory: planned.directory },
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancelRunner(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
            location: { id: planned.targetID, name: planned.targetName, directory: planned.directory },
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error")
              return yield* Effect.fail(
                result.error?.startsWith(`Task error (task_id: ${nextSession.id},`)
                  ? new Error(result.error)
                  : taskFailure("error", result.error ?? "Unknown error"),
              )
            if (result?.status === "cancelled")
              return yield* Effect.fail(
                taskFailure("cancelled", "The invocation stopped; the child Session can be resumed"),
              )
            return {
              title: params.description,
              metadata,
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? "",
                location: { id: planned.targetID, name: planned.targetName, directory: planned.directory },
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return () =>
      Effect.gen(function* () {
        const backgroundEnabled = ConfigExperimental.backgroundSubagents(
          yield* config.get(),
          flags.experimentalBackgroundSubagents,
        )
        return {
          description: backgroundEnabled ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n") : DESCRIPTION,
          parameters: Parameters,
          jsonSchema: backgroundEnabled ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            run(params, ctx).pipe(Effect.orDie),
        }
      })
  }),
)

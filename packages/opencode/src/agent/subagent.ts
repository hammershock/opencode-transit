export * as Subagent from "./subagent"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hash } from "@opencode-ai/core/util/hash"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { SessionID } from "@/session/schema"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Agent } from "./agent"
import { deriveSubagentSessionPermission } from "./subagent-permissions"
import { Context, Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import fs from "fs/promises"
import path from "path"

const Source = Schema.Literals(["builtin", "global", "compatibility"])
const Effective = Schema.Literals(["active", "inactive"])
const Reason = Schema.Literals(["default", "global", "session", "permission", "parent-disabled"])
const AccessJournal = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  parentAgentID: Schema.String,
  subagentID: Schema.String,
  active: Schema.Boolean,
})

export const DefinitionDraft = Schema.Struct({
  name: Schema.NonEmptyString,
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  steps: Schema.optional(PositiveInt),
  permission: Schema.optional(ConfigPermissionV1.Info),
})
export type DefinitionDraft = typeof DefinitionDraft.Type

export const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  steps: Schema.optional(PositiveInt),
  permission: Schema.optional(ConfigPermissionV1.Info),
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ),
  effective: Effective,
  reason: Reason,
  approvalRequired: Schema.Boolean,
  capabilities: Schema.Array(Schema.String),
  editable: Schema.Boolean,
  source: Source,
})
export type Entry = typeof Entry.Type

export const Snapshot = Schema.Struct({
  revision: Schema.String,
  parentAgentID: Schema.String,
  sessionID: Schema.optional(SessionID),
  entries: Schema.Array(Entry),
  diagnostics: Schema.Array(Schema.String),
})
export type Snapshot = typeof Snapshot.Type

export const ResolveInput = Schema.Struct({
  parentAgentID: Schema.String,
  sessionID: Schema.optional(SessionID),
  includeInactive: Schema.optional(Schema.Boolean),
})
export type ResolveInput = typeof ResolveInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SubagentNotFoundError", {
  id: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SubagentConflictError", {
  expectedRevision: Schema.String,
  actualRevision: Schema.String,
}) {}

export class ReadonlyError extends Schema.TaggedErrorClass<ReadonlyError>()("SubagentReadonlyError", {
  id: Schema.String,
}) {}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Snapshot>
  readonly render: (snapshot: Snapshot) => string
  readonly setSessionAccess: (input: {
    sessionID: SessionID
    parentAgentID: string
    subagentID: string
    active: boolean
    expectedRevision: string
  }) => Effect.Effect<Snapshot, ConflictError | NotFoundError>
  readonly setGlobalAccess: (input: {
    sessionID: SessionID
    parentAgentID: string
    subagentID: string
    active: boolean
    expectedRevision: string
  }) => Effect.Effect<Snapshot, ConflictError | NotFoundError>
  readonly create: (input: {
    sessionID: SessionID
    parentAgentID: string
    expectedRevision: string
    definition: DefinitionDraft
  }) => Effect.Effect<Snapshot, ConflictError>
  readonly update: (input: {
    sessionID: SessionID
    parentAgentID: string
    subagentID: string
    expectedRevision: string
    definition: DefinitionDraft
  }) => Effect.Effect<Snapshot, ConflictError | NotFoundError | ReadonlyError>
  readonly remove: (input: {
    sessionID: SessionID
    parentAgentID: string
    subagentID: string
    expectedRevision: string
  }) => Effect.Effect<Snapshot, ConflictError | NotFoundError | ReadonlyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Subagent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const flock = yield* EffectFlock.Service
    const withCatalogLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      flock.withLock(effect, "subagent-catalog").pipe(
        Effect.catchTag("LockTimeoutError", (error) => Effect.die(error)),
        Effect.catchTag("LockCompromisedError", (error) => Effect.die(error)),
      )

    const resolveCurrent = Effect.fn("Subagent.resolveCurrent")(function* (input: ResolveInput) {
      const parent = yield* agents.get(input.parentAgentID)
      if (!parent) return yield* Effect.die(new Error(`Parent Agent not found: ${input.parentAgentID}`))
      const session = input.sessionID ? yield* sessions.get(input.sessionID).pipe(Effect.orDie) : undefined
      const global = yield* config.getGlobal()
      const parentDisabled =
        Permission.evaluate("task", "*", parent.permission, session?.permission ?? []).action === "deny"

      const parentID = parent.id ?? parent.name
      const candidates = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const conflicts = candidates
        .map((item) => item.id ?? item.name)
        .filter((id, index, ids) => ids.indexOf(id) !== index)
      const entries = candidates
        .filter((item) => !conflicts.includes(item.id ?? item.name))
        .map((item): Entry => {
          const id = item.id ?? item.name
          const sessionValue = session?.subagentAccess?.[parentID]?.[id]
          const globalValue = global.subagent_access?.[parentID]?.[id]
          const sessionPermission = taskPermission(id, item.name, session?.permission ?? [])
          const globalPermission = taskPermission(id, item.name, parent.permission)
          const access = resolveEffectiveAccess({
            parentDisabled,
            session: sessionValue,
            sessionPermission: sessionPermission.rule.action,
            hasSessionPermissionRule: sessionPermission.matched,
            global: globalValue,
            permission: globalPermission.rule.action,
            hasPermissionRule: globalPermission.matched,
          })
          const active = access.effective === "active"
          const approvalRequired =
            active &&
            access.reason === "permission" &&
            (sessionPermission.matched ? sessionPermission.rule.action : globalPermission.rule.action) === "ask"
          const permission = Permission.merge(
            item.permission,
            deriveSubagentSessionPermission({
              parentSessionPermission: session?.permission ?? [],
              subagent: item,
            }),
          )
          return {
            id,
            name: item.name,
            description: item.description,
            variant: item.variant,
            prompt: item.prompt,
            steps: item.steps,
            permission: item.configuredPermission,
            model: item.model,
            effective: active ? "active" : "inactive",
            reason: access.reason,
            approvalRequired,
            capabilities: [...summarizeCapabilities(permission), ...(approvalRequired ? ["approval-required"] : [])],
            editable: item.editable ?? false,
            source: item.source ?? "compatibility",
          }
        })
        .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      const diagnostics = [
        ...duplicateDiagnostics(entries),
        ...[...new Set(conflicts)].map((id) => `Conflicting subagent ID: ${id}`),
      ]
      return {
        revision: Hash.sha256(
          JSON.stringify({
            parent: parentID,
            access: global.subagent_access,
            session: session?.subagentAccess,
            definitions: candidates.map((item) => ({
              id: item.id ?? item.name,
              name: item.name,
              description: item.description,
              model: item.model,
              variant: item.variant,
              prompt: item.prompt,
              steps: item.steps,
              permission: item.permission,
              options: item.options,
            })),
            entries,
          }),
        ),
        parentAgentID: parentID,
        sessionID: session?.id,
        entries: entries.filter((item) => input.includeInactive !== false || item.effective === "active"),
        diagnostics,
      }
    })

    const clearSessionOverride = Effect.fnUntraced(function* (
      session: Session.Info,
      parentAgentID: string,
      subagentID: string,
    ) {
      const parent = { ...session.subagentAccess?.[parentAgentID] }
      delete parent[subagentID]
      const subagentAccess = { ...session.subagentAccess, [parentAgentID]: parent }
      if (Object.keys(parent).length === 0) delete subagentAccess[parentAgentID]
      yield* sessions.setSubagentAccess({
        sessionID: session.id,
        subagentAccess: Object.keys(subagentAccess).length > 0 ? subagentAccess : undefined,
      })
    })

    const recoverAccessJournalUnlocked = Effect.fnUntraced(function* () {
      const pending = yield* readAccessJournal()
      if (!pending) return false
      const global = yield* config.getGlobal()
      yield* config.updateGlobal({
        subagent_access: {
          ...global.subagent_access,
          [pending.parentAgentID]: {
            ...global.subagent_access?.[pending.parentAgentID],
            [pending.subagentID]: pending.active,
          },
        },
      })
      const session = yield* sessions.get(pending.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (session) yield* clearSessionOverride(session, pending.parentAgentID, pending.subagentID)
      yield* clearAccessJournal()
      return true
    })

    const recoverAccessJournal = () =>
      readAccessJournal().pipe(
        Effect.flatMap((pending) =>
          pending ? withCatalogLock(recoverAccessJournalUnlocked()) : Effect.succeed(false),
        ),
      )

    const resolve = Effect.fn("Subagent.resolve")(function* (input: ResolveInput) {
      yield* recoverAccessJournal()
      const snapshot = yield* resolveCurrent(input)
      if (!(yield* readAccessJournal())) return snapshot
      yield* recoverAccessJournal()
      return yield* resolveCurrent(input)
    })

    const requireRevisionUnlocked = Effect.fnUntraced(function* (input: ResolveInput & { expectedRevision: string }) {
      // Definition files may be edited outside the manager while its dialog is
      // open. Reload before comparing so expectedRevision is a real CAS token.
      yield* config.invalidate()
      yield* agents.invalidate()
      const current = yield* resolveCurrent({ ...input, includeInactive: true })
      if (current.revision !== input.expectedRevision)
        return yield* new ConflictError({
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      return current
    })

    const requireEntry = Effect.fnUntraced(function* (snapshot: Snapshot, id: string) {
      const entry = snapshot.entries.find((item) => item.id === id)
      if (!entry) return yield* new NotFoundError({ id })
      return entry
    })

    const setSessionAccess: Interface["setSessionAccess"] = Effect.fn("Subagent.setSessionAccess")(function* (input) {
      return yield* withCatalogLock(
        Effect.gen(function* () {
          yield* recoverAccessJournalUnlocked()
          const current = yield* requireRevisionUnlocked(input)
          yield* requireEntry(current, input.subagentID)
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          yield* sessions.setSubagentAccess({
            sessionID: input.sessionID,
            subagentAccess: {
              ...session.subagentAccess,
              [current.parentAgentID]: {
                ...session.subagentAccess?.[current.parentAgentID],
                [input.subagentID]: input.active,
              },
            },
          })
          return yield* resolveCurrent({ ...input, includeInactive: true })
        }),
      )
    })

    const setGlobalAccess: Interface["setGlobalAccess"] = Effect.fn("Subagent.setGlobalAccess")(function* (input) {
      return yield* withCatalogLock(
        Effect.gen(function* () {
          yield* recoverAccessJournalUnlocked()
          const current = yield* requireRevisionUnlocked(input)
          yield* requireEntry(current, input.subagentID)
          const global = yield* config.getGlobal()
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          yield* writeAccessJournal({
            version: 1,
            sessionID: input.sessionID,
            parentAgentID: current.parentAgentID,
            subagentID: input.subagentID,
            active: input.active,
          })
          yield* config.updateGlobal({
            subagent_access: {
              ...global.subagent_access,
              [current.parentAgentID]: {
                ...global.subagent_access?.[current.parentAgentID],
                [input.subagentID]: input.active,
              },
            },
          })
          yield* clearSessionOverride(session, current.parentAgentID, input.subagentID)
          yield* clearAccessJournal()
          return yield* resolveCurrent({ ...input, includeInactive: true })
        }),
      )
    })

    const create: Interface["create"] = Effect.fn("Subagent.create")(function* (input) {
      return yield* withCatalogLock(
        Effect.gen(function* () {
          yield* recoverAccessJournalUnlocked()
          const current = yield* requireRevisionUnlocked(input)
          const ids = new Set([
            ...current.entries.map((item) => item.id),
            ...Object.keys((yield* config.getGlobal()).agent ?? {}),
            ...(yield* Effect.promise(reservedDefinitionIDs)),
          ])
          const base = slug(input.definition.name)
          const id = Array.from({ length: 100 }, (_, index) => (index === 0 ? base : `${base}-${index + 1}`)).find(
            (candidate) => !ids.has(candidate),
          )
          if (!id) return yield* Effect.die(new Error("Unable to allocate subagent identity"))
          yield* writeDefinition(id, input.definition)
          yield* config.invalidate()
          yield* agents.invalidate()
          return yield* resolveCurrent({ ...input, includeInactive: true })
        }),
      )
    })

    const update: Interface["update"] = Effect.fn("Subagent.update")(function* (input) {
      return yield* withCatalogLock(
        Effect.gen(function* () {
          yield* recoverAccessJournalUnlocked()
          const current = yield* requireRevisionUnlocked(input)
          const entry = yield* requireEntry(current, input.subagentID)
          if (!entry.editable) return yield* new ReadonlyError({ id: input.subagentID })
          yield* writeDefinition(entry.id, input.definition)
          yield* config.invalidate()
          yield* agents.invalidate()
          return yield* resolveCurrent({ ...input, includeInactive: true })
        }),
      )
    })

    const remove: Interface["remove"] = Effect.fn("Subagent.remove")(function* (input) {
      return yield* withCatalogLock(
        Effect.gen(function* () {
          yield* recoverAccessJournalUnlocked()
          const current = yield* requireRevisionUnlocked(input)
          const entry = yield* requireEntry(current, input.subagentID)
          if (!entry.editable) return yield* new ReadonlyError({ id: input.subagentID })
          if (entry.source === "global" && !(yield* moveDefinitionToTrash(entry.id))) {
            yield* writeDefinition(entry.id, definitionFromEntry(entry))
            yield* moveDefinitionToTrash(entry.id)
          }
          // Keep a tombstone overlay for built-ins and custom IDs alike. A future
          // restore removes it; meanwhile a same-name Add cannot inherit policies
          // that still refer to the deleted stable ID.
          yield* config.updateGlobal({ agent: { [entry.id]: { id: entry.id, disable: true } } })
          yield* agents.invalidate()
          return yield* resolveCurrent({ ...input, includeInactive: true })
        }),
      )
    })

    return Service.of({
      resolve,
      render,
      setSessionAccess,
      setGlobalAccess,
      create,
      update,
      remove,
    })
  }),
)

function taskPermission(id: string, name: string, ruleset: Parameters<typeof Permission.evaluate>[2]) {
  const rule = ruleset.findLast(
    (item) => item.permission === "task" && (Wildcard.match(id, item.pattern) || Wildcard.match(name, item.pattern)),
  )
  return {
    matched: rule !== undefined,
    rule: rule ?? { permission: "task", pattern: "*", action: "ask" as const },
  }
}

export function resolveEffectiveAccess(input: {
  parentDisabled: boolean
  session?: boolean
  sessionPermission?: "allow" | "ask" | "deny"
  hasSessionPermissionRule?: boolean
  global?: boolean
  permission: "allow" | "ask" | "deny"
  hasPermissionRule: boolean
}): Pick<Entry, "effective" | "reason"> {
  if (input.parentDisabled) return { effective: "inactive", reason: "parent-disabled" }
  if (input.session !== undefined) return { effective: input.session ? "active" : "inactive", reason: "session" }
  if (input.hasSessionPermissionRule)
    return { effective: input.sessionPermission === "deny" ? "inactive" : "active", reason: "permission" }
  if (input.global !== undefined) return { effective: input.global ? "active" : "inactive", reason: "global" }
  if (input.hasPermissionRule)
    return { effective: input.permission === "deny" ? "inactive" : "active", reason: "permission" }
  return { effective: "active", reason: "default" }
}

export function summarizeCapabilities(rules: Agent.Info["permission"]) {
  const edit = Permission.evaluate("edit", "*", rules).action
  const shell = Permission.evaluate("bash", "*", rules).action
  const web = ["webfetch", "websearch"].some(
    (permission) => Permission.evaluate(permission, "*", rules).action !== "deny",
  )
  const task = Permission.evaluate("task", "*", rules).action
  const base = edit === "deny" && shell === "deny" ? "read-only" : edit !== "deny" ? "workspace-write" : "restricted"
  const custom = rules.some(
    (rule) =>
      !["*", "edit", "bash", "webfetch", "websearch", "task", "read", "grep", "glob", "list"].includes(
        rule.permission,
      ) || rule.pattern !== "*",
  )
  return [
    ...(edit === "allow" && shell === "allow" && !custom ? ["full-access"] : [base]),
    ...(shell === "allow" ? ["shell"] : shell === "ask" ? ["shell-approval"] : []),
    ...(web ? ["web"] : []),
    task === "deny" ? "no-delegation" : "delegation",
    ...(custom ? ["restricted"] : []),
  ]
}

function duplicateDiagnostics(entries: readonly Entry[]) {
  const names = entries.map((item) => item.name)
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].map(
    (name) => `Duplicate subagent name: ${name}`,
  )
}

function definitionConfig(id: string, definition: DefinitionDraft): ConfigAgentV1.Info {
  return {
    id,
    schema_revision: 1,
    name: definition.name,
    mode: "subagent",
    model: definition.model,
    variant: definition.variant,
    description: definition.description,
    prompt: definition.prompt,
    steps: definition.steps,
    permission: definition.permission,
  }
}

function definitionFromEntry(entry: Entry): DefinitionDraft {
  return {
    name: entry.name,
    model: entry.model ? `${entry.model.providerID}/${entry.model.modelID}` : undefined,
    variant: entry.variant,
    description: entry.description,
    prompt: entry.prompt,
    steps: entry.steps,
    permission: entry.permission,
  }
}

function definitionFile(id: string) {
  return path.join(Global.Path.config, "agents", `.subagent-${slug(id)}-${Hash.sha256(id).slice(0, 12)}.md`)
}

function writeDefinition(id: string, definition: DefinitionDraft) {
  const config = definitionConfig(id, definition)
  const content = matter.stringify(
    definition.prompt ?? "",
    Object.fromEntries(
      Object.entries({
        id: config.id,
        schema_revision: config.schema_revision,
        name: config.name,
        mode: config.mode,
        model: config.model,
        variant: config.variant,
        description: config.description,
        steps: config.steps,
        permission: config.permission,
      }).filter((entry) => entry[1] !== undefined),
    ),
  )
  return Effect.promise(() => atomicWrite(definitionFile(id), content))
}

async function reservedDefinitionIDs() {
  const directory = path.join(Global.Path.config, ".trash", "subagents")
  const files = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const ids = await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith(".md"))
      .map((file) =>
        fs
          .readFile(path.join(directory, file.name), "utf8")
          .then((content) => matter(content).data.id)
          .catch(() => undefined),
      ),
  )
  return ids.filter((id): id is string => typeof id === "string")
}

function moveDefinitionToTrash(id: string) {
  return Effect.promise(async () => {
    const file = definitionFile(id)
    if (!(await exists(file))) return false
    const directory = path.join(Global.Path.config, ".trash", "subagents")
    await fs.mkdir(directory, { recursive: true })
    await fs.rename(file, path.join(directory, `${Date.now()}-${path.basename(file)}`))
    await syncDirectory(path.dirname(file))
    await syncDirectory(directory)
    return true
  })
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  return fs
    .open(temp, "wx", 0o600)
    .then((handle) =>
      handle
        .writeFile(content)
        .then(() => handle.sync())
        .finally(() => handle.close()),
    )
    .then(() => fs.rename(temp, file))
    .then(() => syncDirectory(path.dirname(file)))
    .catch(async (error) => {
      await fs.unlink(temp).catch(() => undefined)
      throw error
    })
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r")
  await handle.sync()
  await handle.close()
}

function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

function accessJournalFile() {
  return path.join(Global.Path.state, "subagent-access-journal.json")
}

function readAccessJournal() {
  return Effect.promise(async () => {
    const content = await fs.readFile(accessJournalFile(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (content === undefined) return undefined
    return Schema.decodeUnknownSync(Schema.fromJsonString(AccessJournal))(content)
  })
}

function writeAccessJournal(journal: typeof AccessJournal.Type) {
  return Effect.promise(() => atomicWrite(accessJournalFile(), JSON.stringify(journal)))
}

function clearAccessJournal() {
  return Effect.promise(async () => {
    await fs.unlink(accessJournalFile()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await syncDirectory(path.dirname(accessJournalFile()))
  })
}

function slug(name: string) {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  )
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function render(snapshot: Snapshot) {
  const header = `<available_subagents revision="${escape(snapshot.revision)}">`
  const close = "</available_subagents>"
  const selected: string[] = []
  const entries = snapshot.entries
    .filter((entry) => entry.effective === "active")
    .toSorted((a, b) => a.id.localeCompare(b.id))
  for (const entry of entries) {
    const prefix = `<subagent id="${truncateEscapedBytes(entry.id, 32).value}" name="${truncateEscapedBytes(entry.name, 32).value}" capabilities="${truncateEscapedBytes(entry.capabilities.join(","), 80).value}">`
    const suffix = "</subagent>"
    const description = compactDescription(
      entry.description ?? "Call only when the user explicitly selects this subagent.",
    )
    const content = truncateEscapedBytes(description, Math.max(0, 240 - Buffer.byteLength(prefix + suffix)))
    const bounded = `${prefix}${content.value}${content.truncated ? "…" : ""}${suffix}`
    if (Buffer.byteLength([header, ...selected, bounded, close].join("\n")) > 8192) break
    selected.push(bounded)
  }
  const truncated = selected.length !== entries.length
  while (truncated && Buffer.byteLength([header, ...selected, "<truncated />", close].join("\n")) > 8192) {
    selected.pop()
  }
  return [header, ...selected, ...(truncated ? ["<truncated />"] : []), close].join("\n")
}

function compactDescription(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function truncateEscapedBytes(value: string, limit: number) {
  return Array.from(value).reduce(
    (result, char) => {
      if (result.truncated) return result
      const next = escape(char)
      if (Buffer.byteLength(result.value + next) <= Math.max(0, limit - 3)) {
        return { value: result.value + next, truncated: false }
      }
      return { ...result, truncated: true }
    },
    { value: "", truncated: false },
  )
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Config.node, Session.node, EffectFlock.node],
})

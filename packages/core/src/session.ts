export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Exit, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, sql, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionCompaction } from "./session/compaction"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionInput } from "./session/input"
import { SessionTask } from "./session/task"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionTaskResult } from "./session/task-result"
import { SessionTurn } from "./session/turn"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Pty } from "./pty"
import { PermissionV2 } from "./permission"
import { ExecutionPolicy } from "./permission/policy"
import { QuestionV2 } from "./question"
import { SessionActivity } from "./session/activity"
import { page } from "./session/agent-activity"
import { SessionAgentActivity } from "@opencode-ai/schema/session-agent-activity"
import { SessionLocationAccess } from "./session/location-access"
import { SessionLocationMutation } from "./session/location-mutation"
import { SyncSetup } from "./sync/setup"
import type { ApprovalMode } from "@opencode-ai/schema/approval-mode"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { FileSystem } from "./filesystem"
import { SessionLocationRuntime } from "./session/location-runtime"
import { RuntimeContext } from "./runtime-context"
import { buildEnvironment, renderEnvironment } from "./runtime-context/builtins"
import { SkillCatalogContextService } from "./skill/catalog-context-service"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillSlashCompatibility } from "./skill/slash-compatibility"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { SessionSkillCatalog } from "./session/skill-catalog"
import { InstructionContext } from "./instruction-context"
import { ToolRegistry } from "./tool/registry"
import { PermissionV1 } from "./v1/permission"
import type { SessionPolicy } from "@opencode-ai/schema/session-policy"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  task?: SessionTaskEvent.Admission
  taskInput?: { messageID: SessionMessage.ID; prompt: Prompt; delivery: SessionInput.Delivery }
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  approvalMode?: ApprovalMode.Mode
  permission?: PermissionV1.Ruleset
  permissionBoundary?: SessionPolicy.Boundary
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
  model?: ModelV2.Ref
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals([
      "move",
      "shell",
      "skill",
      "switchAgent",
      "compact",
      "wait",
      "location",
      "modelContext",
    ]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class LocationRebindError extends Schema.TaggedErrorClass<LocationRebindError>()("Session.LocationRebindError", {
  message: Schema.String,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | SkillCatalogContextService.AdmissionError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly activity: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit?: number
  }) => Effect.Effect<Schema.Schema.Type<typeof SessionAgentActivity.Page>, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  /** Inspect the frozen durable model context without resolving the Session Location. */
  readonly modelContext: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ModelContext.Generation | undefined, NotFoundError | ContextSnapshotDecodeError>
  /** Inspect the per-turn prepared request parts without resolving the Session Location: runtime parts, agent prompt, model, request headers, and the latest compaction checkpoint. */
  readonly requestContext: (sessionID: SessionSchema.ID) => Effect.Effect<
    {
      runtimeParts: ReadonlyArray<RuntimeContext.Rendered>
      agentSystem: string | null
      systemParts: ReadonlyArray<ModelContext.SystemPart>
      environment: string | null
      environmentInfo: ModelContext.Environment | null
      instructions: ModelContext.Instructions
      tools: ModelContext.Tools
      model: ModelV2.Ref | null
      headers: Readonly<Record<string, string>>
      compaction: { reason: "auto" | "manual"; summary: string; recent: string; source?: "legacy" } | null
    },
    NotFoundError
  >
  /** Inspect the atomic controller-local Skill view appended to the next provider request. */
  readonly skillView: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionSkillCatalog.View | undefined, NotFoundError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
    selection?: Prompt["selection"]
    command?: Prompt["command"]
  }) => Effect.Effect<
    SessionInput.Admitted,
    NotFoundError | PromptConflictError | OperationUnavailableError | SkillCatalogContextService.AdmissionError
  >
  readonly skillSlash: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    name: string
    arguments: string
    files?: ReadonlyArray<PromptInput.FileAttachment>
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | PromptConflictError
    | OperationUnavailableError
    | SkillCatalogContextService.AdmissionError
    | SkillSlashCompatibility.Error
  >
  /** Admits one queued prompt and resolves only from that exact input's durable terminal settlement. */
  readonly promptTurn: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
  }) => Effect.Effect<
    SessionTurn.Outcome,
    | NotFoundError
    | PromptConflictError
    | OperationUnavailableError
    | SkillCatalogContextService.AdmissionError
    | SessionRunner.RunError
  >
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<
    void,
    | NotFoundError
    | OperationUnavailableError
    | SessionExecution.CompactionBusyError
    | SessionRunnerModel.Error
    | MessageDecodeError
    | SessionCompaction.ManualError
  >
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly activate: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Skill.Activation, NotFoundError | OperationUnavailableError>
  readonly locationBlockers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<string>, NotFoundError>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | OperationUnavailableError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly rebindLocation: (input: {
    readonly sessionID: SessionSchema.ID
    readonly expectedRevision: number
    readonly destination: Location.Ref
  }) => Effect.Effect<
    { readonly status: "unchanged" | "rebound"; readonly revision: number; readonly warnings: readonly string[] },
    NotFoundError | LocationRebindError
  >
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error | OperationUnavailableError>
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | Snapshot.Error | OperationUnavailableError>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const locationMutation = yield* SessionLocationMutation.Service
    const locationRuntime = yield* SessionLocationRuntime.Service
    const activity = yield* SessionActivity.Service
    const locationAccess = yield* SessionLocationAccess.Service
    const requireLocation = Effect.fn("V2Session.requireLocation")(function* (sessionID: SessionSchema.ID) {
      return yield* locationAccess.require(sessionID).pipe(
        Effect.catchTag("SessionLocationAccess.NotFoundError", () => new NotFoundError({ sessionID })),
        Effect.catchTag(
          "SessionLocationAccess.UnresolvedError",
          () => new OperationUnavailableError({ operation: "location" }),
        ),
      )
    })
    const syncSetup = yield* SyncSetup.Service
    const activateCatalog = Effect.fn("V2Session.activateCatalog")(function* (
      session: SessionSchema.Info,
      location: Location.Ref,
      forceReload: boolean,
    ) {
      const previous = yield* SessionSkillCatalog.view(db, session.id)
      const attempt = yield* Effect.gen(function* () {
        const catalog = yield* SkillCatalogContextService.Service
        const loaded = yield* catalog.load({ forceReload })
        const agents = yield* AgentV2.Service
        const selection = yield* agents.select(session.agent)
        const admitted = SessionSkillCatalog.make(
          loaded.snapshot.revision,
          selection.info ? SkillV2.available(loaded.snapshot.skills, selection.info) : [],
        )
        const guidance = yield* SkillGuidance.Service
        return {
          loaded,
          admitted,
          guidance: yield* guidance.load(selection, loaded.snapshot),
        }
      }).pipe(Effect.provide(locations.get(location)), Effect.exit)
      if (Exit.isFailure(attempt)) {
        yield* Effect.logWarning("Skill catalog activation failed", { sessionID: session.id })
        return Skill.Activation.make({
          status: previous ? "retained" : "unavailable",
          diagnostics: [
            Skill.ActivationDiagnostic.make({
              kind: "reload-failed",
              severity: "warning",
              sourceLabel: "Skill catalog",
            }),
          ],
        })
      }
      if (attempt.value.loaded.transient && previous)
        return Skill.Activation.make({ status: "retained", diagnostics: attempt.value.loaded.diagnostics })
      const unchanged =
        previous?.catalog.digest === attempt.value.admitted.digest && previous.guidance === attempt.value.guidance
      yield* SessionSkillCatalog.replace(db, session.id, {
        catalog: attempt.value.admitted,
        guidance: attempt.value.guidance,
      })
      return Skill.Activation.make({
        status: previous ? (unchanged ? "unchanged" : "advanced") : "initialized",
        diagnostics: attempt.value.loaded.diagnostics,
      })
    })
    const ensureContextForAdmission = Effect.fn("V2Session.ensureContextForAdmission")(function* (
      session: SessionSchema.Info,
      location: Location.Ref,
    ) {
      if ((yield* SessionSkillCatalog.view(db, session.id))?.guidance !== undefined) return
      const unavailable = () => new OperationUnavailableError({ operation: "modelContext" })
      const activation = yield* activateCatalog(session, location, true)
      if (activation.status === "unavailable") return yield* unavailable()
    })
    // Drop the per-Session runtime cache (controller-local catalog snapshot included)
    // so the next provider turn and /context inspection re-read the Target registry.
    // Invalidation is a cheap in-process Ref clear; the registry itself is only loaded
    // lazily by the renderer and never here.
    const invalidateRuntimeContext = (sessionID: SessionSchema.ID, location: Location.Ref) =>
      Effect.gen(function* () {
        const runtime = yield* RuntimeContext.Service
        yield* runtime.invalidate(sessionID)
      }).pipe(
        Effect.provide(locations.get(location)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.logWarning("Runtime context invalidation failed", { sessionID, cause: exit.cause }),
        ),
      )
    const runtimeBlockers = Effect.fn("V2Session.runtimeLocationBlockers")(function* (sessionID: SessionSchema.ID) {
      if (!(yield* store.get(sessionID))) return yield* new NotFoundError({ sessionID })
      const blockers: string[] = []
      if ((yield* execution.active).has(sessionID)) blockers.push("agent_turn")
      if (
        (yield* SessionInput.hasPending(db, sessionID, "steer")) ||
        (yield* SessionInput.hasPending(db, sessionID, "queue"))
      )
        blockers.push("queued_turn")
      blockers.push(...(yield* activity.blockers(sessionID)))
      return blockers
    })
    const locationScopedBlockers = (sessionID: SessionSchema.ID, ref: Location.Ref) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(ref)
          const pty = Context.get(context, Pty.Service)
          const permissions = Context.get(context, PermissionV2.Service)
          const questions = Context.get(context, QuestionV2.Service)
          const blockers: string[] = []
          if ((yield* pty.list()).some((item) => item.status === "running")) blockers.push("terminal_pty")
          if ((yield* permissions.forSession(sessionID)).length) blockers.push("permission")
          if ((yield* questions.list()).some((item) => item.sessionID === sessionID)) blockers.push("question")
          return blockers
        }),
      )
    const locationBlockers = Effect.fn("V2Session.locationBlockers")(function* (sessionID: SessionSchema.ID) {
      const runtime = [...(yield* runtimeBlockers(sessionID))]
      const resolution = yield* locationAccess.resolve(sessionID).pipe(
        Effect.catchTag("SessionLocationAccess.NotFoundError", () => new NotFoundError({ sessionID })),
        Effect.catchTag("SessionLocationAccess.UnresolvedError", () =>
          Effect.succeed({ status: "resolution_failed" as const, message: "Session Location resolution failed" }),
        ),
      )
      if (resolution.status !== "resolved") return runtime
      return [...runtime, ...(yield* locationScopedBlockers(sessionID, resolution.location))]
    })
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const prompt = Effect.fn("V2Session.prompt")(
      (input: {
        id?: SessionMessage.ID
        sessionID: SessionSchema.ID
        prompt: PromptInput.Prompt
        delivery?: SessionInput.Delivery
        resume?: boolean
        selection?: Prompt["selection"]
        command?: Prompt["command"]
      }) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.uninterruptible(
            Effect.gen(function* () {
              const location = yield* requireLocation(input.sessionID)
              const session = yield* result.get(input.sessionID)
              const messageID = input.id ?? SessionMessage.ID.create()
              const delivery = input.delivery ?? "steer"
              const base = Prompt.make({
                ...resolvePrompt(input.prompt),
                selection: input.selection,
                command: input.command,
              })
              const recorded = input.id === undefined ? undefined : yield* SessionInput.find(db, messageID)
              if (recorded) {
                if (
                  recorded.sessionID !== input.sessionID ||
                  recorded.delivery !== delivery ||
                  !SkillCatalogContextService.retryEquivalent(recorded.prompt, base, input.prompt.skills ?? [])
                )
                  return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
                if (input.resume !== false) yield* execution.wake(recorded.sessionID)
                return recorded
              }
              yield* ensureContextForAdmission(session, location)
              const admittedCatalog = yield* SessionSkillCatalog.get(db, input.sessionID)
              const mentions = input.prompt.skills ?? []
              const skills =
                mentions.length === 0
                  ? []
                  : yield* Effect.gen(function* () {
                      const admission = yield* SkillCatalogContextService.Service
                      return yield* admission.resolve({
                        sessionID: input.sessionID,
                        messageID,
                        text: input.prompt.text,
                        mentions,
                        agent: session.agent,
                        admittedCatalog,
                      })
                    }).pipe(Effect.provide(locations.get(location)))
              const resolved = Prompt.make({
                ...base,
                ...(skills.length === 0 ? {} : { invocations: skills }),
              })
              if (session.revert)
                yield* SessionRevert.commit(session).pipe(
                  Effect.provideService(EventV2.Service, events),
                  Effect.provideService(Database.Service, database),
                )
              const expected = { sessionID: input.sessionID, messageID, prompt: resolved, delivery }
              const admitted = yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: input.sessionID,
                prompt: resolved,
                delivery,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                    : defect instanceof SessionInput.PromptBackendConflict
                      ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                      : Effect.die(defect),
                ),
              )
              if (!SessionInput.equivalent(admitted, expected))
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              if (input.resume !== false) yield* execution.wake(admitted.sessionID)
              return admitted
            }),
          ),
        ),
    )

    const skillSlash = Effect.fn("V2Session.skillSlash")(
      (input: {
        id?: SessionMessage.ID
        sessionID: SessionSchema.ID
        name: string
        arguments: string
        files?: ReadonlyArray<PromptInput.FileAttachment>
        resume?: boolean
      }) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.uninterruptible(
            Effect.gen(function* () {
              const location = yield* requireLocation(input.sessionID)
              const session = yield* result.get(input.sessionID)
              const messageID = input.id ?? SessionMessage.ID.create()
              const request = SkillSlashCompatibility.request(input)
              const expected = resolvePrompt(request)
              const recorded = input.id === undefined ? undefined : yield* SessionInput.find(db, messageID)
              if (recorded) {
                if (
                  recorded.sessionID !== input.sessionID ||
                  recorded.delivery !== "steer" ||
                  !SkillSlashCompatibility.retryEquivalent(recorded.prompt, expected, input.name)
                )
                  return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
                if (input.resume !== false) yield* execution.wake(recorded.sessionID)
                return recorded
              }

              yield* ensureContextForAdmission(session, location)
              const resolved = yield* Effect.gen(function* () {
                const skills = yield* SkillV2.Service
                const current = yield* skills.catalog()
                const resolved = SkillSlashCompatibility.resolve(input, current.snapshot.skills)
                if (resolved instanceof SkillSlashCompatibility.Error) return yield* resolved
                return resolved
              }).pipe(Effect.provide(locations.get(location)))
              return yield* prompt({
                id: messageID,
                sessionID: input.sessionID,
                prompt: resolved,
                resume: input.resume,
              })
            }),
          ),
        ),
    )

    const result = Service.of({
      activity: Effect.fn("V2Session.activity")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* page(input).pipe(Effect.provideService(Database.Service, database))
      }),
      create: Effect.fn("V2Session.create")((input) =>
        locationMutation.withLock(
          Effect.gen(function* () {
            const sessionID = input.id ?? SessionSchema.ID.create()
            if (
              input.task &&
              (!input.taskInput ||
                input.task.backend !== "v2" ||
                input.taskInput.delivery !== "queue" ||
                input.task.childSessionID !== sessionID ||
                input.taskInput.messageID !== input.task.inputID ||
                input.parentID !== input.task.parentSessionID)
            )
              return yield* Effect.die(new SessionTask.AdmissionConflict())
            if (input.taskInput && !input.task) return yield* Effect.die(new SessionTask.AdmissionConflict())
            const recorded = yield* store.get(sessionID)
            if (recorded) {
              if (input.task && input.taskInput) {
                const invocation = yield* SessionTask.find(db, input.task.inputID)
                const inbox = yield* SessionInput.find(db, input.taskInput.messageID)
                if (
                  recorded.parentID !== input.parentID ||
                  invocation?.root_session_id !== input.task.rootSessionID ||
                  invocation?.parent_session_id !== input.task.parentSessionID ||
                  invocation?.parent_message_id !== input.task.parentMessageID ||
                  invocation?.call_id !== input.task.callID ||
                  invocation?.prompt_digest !== input.task.promptDigest ||
                  invocation?.child_session_id !== sessionID ||
                  invocation?.description !== input.task.description ||
                  invocation?.agent_id !== input.task.agentID ||
                  invocation?.location_revision !== input.task.locationRevision ||
                  invocation?.backend !== "v2" ||
                  invocation?.background !== (input.task.background ?? false) ||
                  !inbox ||
                  !SessionInput.equivalent(inbox, {
                    sessionID,
                    prompt: input.taskInput.prompt,
                    delivery: input.taskInput.delivery,
                  })
                )
                  return yield* Effect.die(new SessionTask.AdmissionConflict())
              }
              return recorded
            }
            const project = yield* projects.resolve(input.location.directory)
            yield* db
              .insert(ProjectTable)
              .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            const now = Date.now()
            // Ownership is captured exactly once at creation. A disabled scheduler
            // still retains the active space so offline changes stay in its outbox.
            const syncSpaceID = (yield* syncSetup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
              ?.namespaceID
            const info = SessionV1.SessionInfo.make({
              id: sessionID,
              parentID: input.parentID,
              slug: Slug.create(),
              version: InstallationVersion,
              projectID: project.id,
              directory: input.location.directory,
              target: input.location.target,
              lastKnownTargetName: input.location.lastKnownTargetName,
              syncSpaceID,
              path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
              workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
              title: `New session - ${new Date(now).toISOString()}`,
              metadata: { "opencode.promptBackend": "v2" },
              approvalMode: input.approvalMode ?? "normal",
              permission: input.permission,
              permissionBoundary: input.permissionBoundary,
              agent: input.agent,
              model: input.model
                ? {
                    id: ModelV2.ID.make(input.model.id),
                    providerID: input.model.providerID,
                    variant: input.model.variant,
                  }
                : undefined,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
            })
            const projected = yield* events
              .publish(
                SessionV1.Event.Created,
                {
                  sessionID,
                  info,
                  ...(input.task ? { task: input.task, taskInput: input.taskInput } : {}),
                },
                {
                  location: input.location,
                  ...(input.task ? { commit: () => SessionTask.validate(db, input.task!.inputID) } : {}),
                },
              )
              .pipe(
                Effect.as({ type: "created" } as const),
                Effect.catchDefect((defect) => {
                  if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                    return Effect.die(defect)
                  }
                  // Concurrent creation lost the projection race. The existing Session identity wins.
                  return store
                    .get(sessionID)
                    .pipe(
                      Effect.flatMap((session) =>
                        session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                      ),
                    )
                }),
              )
            if (projected.type === "existing") return projected.session
            // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
            const created = yield* result.get(sessionID).pipe(Effect.orDie)
            // RFC-0012 defines creation and first display as a Session activation.
            // Materialize the controller-local Skill view before any client can send
            // the first prompt through either the V2 or compatibility prompt path.
            yield* activateCatalog(created, input.location, true)
            return created
          }),
        ),
      ),
      rebindLocation: Effect.fn("V2Session.rebindLocation")((input) =>
        locationMutation.withLock(
          activity.withExclusive(
            [input.sessionID],
            Effect.gen(function* () {
              const before = yield* store.get(input.sessionID)
              if (!before) return yield* new NotFoundError({ sessionID: input.sessionID })
              if (before.locationRevision !== input.expectedRevision)
                return yield* new LocationRebindError({
                  message: `Location revision changed: expected ${input.expectedRevision}, actual ${before.locationRevision}`,
                })
              if (
                before.location.directory === input.destination.directory &&
                before.location.workspaceID === input.destination.workspaceID &&
                JSON.stringify(before.location.target) === JSON.stringify(input.destination.target)
              )
                return { status: "unchanged" as const, revision: before.locationRevision, warnings: [] }
              const blockers = yield* locationBlockers(input.sessionID)
              if (blockers.length)
                return yield* new LocationRebindError({ message: `Session is not idle: ${blockers.join(", ")}` })

              // Materialize the candidate and prove its root can actually be used before
              // committing. Service construction alone does not reject a missing local path.
              const revision = input.expectedRevision + 1
              const contextGeneration = yield* Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* locations.contextEffect(input.destination)
                  const filesystem = Context.get(context, FileSystem.Service)
                  const status = yield* filesystem.directoryStatus(RelativePath.make("."))
                  if (status.status === "missing")
                    return yield* new LocationRebindError({ message: "Destination directory does not exist" })
                  if (status.status === "not-directory")
                    return yield* new LocationRebindError({ message: "Destination path is not a directory" })
                  // Listing is the least invasive cross-provider access check and catches
                  // unreadable local directories as well as Rexd filesystem denial.
                  yield* filesystem.list({ path: RelativePath.make(".") })
                  const catalog = Context.get(context, SkillCatalogContextService.Service)
                  const loaded = yield* catalog.load({ forceReload: false })
                  const agents = Context.get(context, AgentV2.Service)
                  const selection = yield* agents.select(before.agent)
                  const guidance = Context.get(context, SkillGuidance.Service)
                  return {
                    admitted: SessionSkillCatalog.make(
                      loaded.snapshot.revision,
                      selection.info ? SkillV2.available(loaded.snapshot.skills, selection.info) : [],
                    ),
                    guidance: yield* guidance
                      .load(selection, loaded.snapshot)
                      .pipe(
                        Effect.mapError(
                          () => new LocationRebindError({ message: "Destination Skill guidance is unavailable" }),
                        ),
                      ),
                  }
                }),
              ).pipe(
                Effect.catchDefect(
                  () => new LocationRebindError({ message: "Destination directory is not accessible" }),
                ),
              )
              const current = yield* store.get(input.sessionID)
              if (!current) return yield* new NotFoundError({ sessionID: input.sessionID })
              if (current.locationRevision !== input.expectedRevision)
                return yield* new LocationRebindError({ message: "Location revision changed during validation" })
              const finalBlockers = yield* locationBlockers(input.sessionID)
              if (finalBlockers.length)
                return yield* new LocationRebindError({
                  message: `Session became non-idle during validation: ${finalBlockers.join(", ")}`,
                })
              yield* events.publish(SessionEvent.LocationRebound, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(Date.now()),
                previous: current.location,
                location: input.destination,
                revision,
              })
              yield* SessionSkillCatalog.replace(db, input.sessionID, {
                catalog: contextGeneration.admitted,
                guidance: contextGeneration.guidance,
              })
              const warnings: string[] = []
              yield* locations.invalidate(current.location).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    warnings.push(`Old Location cleanup failed: ${String(cause)}`)
                  }),
                ),
              )
              yield* locationRuntime.rebound(input.sessionID).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    warnings.push(`Location runtime reset failed: ${String(cause)}`)
                  }),
                ),
              )
              return { status: "rebound" as const, revision, warnings }
            }),
          ),
        ),
      ),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      modelContext: Effect.fn("V2Session.modelContext")(function* (sessionID) {
        yield* result.get(sessionID)
        return undefined
      }),
      requestContext: Effect.fn("V2Session.requestContext")(function* (sessionID) {
        const session = yield* result.get(sessionID)

        const contextAttempt = yield* Effect.gen(function* () {
          const locationRef = yield* requireLocation(sessionID)
          return yield* Effect.gen(function* () {
            const agents = yield* AgentV2.Service
            const agent = yield* agents.select(session.agent)
            const runtime = yield* RuntimeContext.Service
            const models = yield* SessionRunnerModel.Service
            const instructions = yield* InstructionContext.Service
            const location = yield* Location.Service
            const tools = yield* ToolRegistry.Service
            const policy = yield* ExecutionPolicy.Service
            const snapshot = yield* policy.resolve(sessionID, agent.id)
            const materialization = yield* tools.materialize(snapshot.rules, [
              ...snapshot.ceilings,
              ...(session.parentID ? [[{ action: "slash_command", resource: "*", effect: "deny" as const }]] : []),
            ])
            const environment = buildEnvironment(location)
            const model = yield* models.resolve(session).pipe(Effect.exit)
            const baseSystem = SessionRunnerModel.systemParts(
              agent.info?.system,
              Exit.isSuccess(model) ? models.system(model.value) : undefined,
            )
            const runtimeParts = yield* runtime.assemble(sessionID, agent)
            return {
              agentSystem: baseSystem.find((part) => part.key === "agent")?.text ?? null,
              systemParts: [...baseSystem, ...runtimeParts],
              runtimeParts,
              environment: renderEnvironment(environment),
              environmentInfo: environment,
              instructions: yield* instructions.list(sessionID),
              tools: materialization.definitions.map((definition) => ({
                name: definition.name,
                description: definition.description,
                inputSchema: definition.inputSchema,
              })),
            }
          }).pipe(Effect.provide(locations.get(locationRef)))
        }).pipe(Effect.exit)

        const compactionRow = yield* db
          .select({
            id: SessionMessageTable.id,
            type: SessionMessageTable.type,
            data: SessionMessageTable.data,
            time: SessionMessageTable.time_created,
          })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const compactionMessage = compactionRow
          ? Schema.decodeUnknownOption(SessionMessage.Message)({
              ...compactionRow.data,
              id: compactionRow.id,
              type: compactionRow.type,
            }).valueOrUndefined
          : undefined
        const legacyRow = yield* db
          .select({
            id: MessageTable.id,
            auto: sql<number>`json_extract(${PartTable.data}, '$.auto')`,
            time: MessageTable.time_created,
          })
          .from(MessageTable)
          .innerJoin(
            PartTable,
            and(
              eq(PartTable.session_id, MessageTable.session_id),
              sql`${PartTable.message_id} = json_extract(${MessageTable.data}, '$.parentID')`,
              sql`json_extract(${PartTable.data}, '$.type') = 'compaction'`,
            ),
          )
          .where(
            and(
              eq(MessageTable.session_id, sessionID),
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
              sql`json_extract(${MessageTable.data}, '$.summary') = 1`,
              sql`json_extract(${MessageTable.data}, '$.finish') IS NOT NULL`,
              sql`json_extract(${MessageTable.data}, '$.error') IS NULL`,
            ),
          )
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const legacyParts =
          legacyRow && (!compactionRow || legacyRow.time > compactionRow.time)
            ? yield* db
                .select({ text: sql<string>`json_extract(${PartTable.data}, '$.text')` })
                .from(PartTable)
                .where(
                  and(
                    eq(PartTable.session_id, sessionID),
                    eq(PartTable.message_id, legacyRow.id),
                    sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
                  ),
                )
                .orderBy(asc(PartTable.id))
                .all()
                .pipe(Effect.orDie)
            : []
        const legacySummary = legacyParts
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n\n")

        return {
          runtimeParts: Exit.isSuccess(contextAttempt) ? contextAttempt.value.runtimeParts : [],
          agentSystem: Exit.isSuccess(contextAttempt) ? contextAttempt.value.agentSystem : null,
          systemParts: Exit.isSuccess(contextAttempt) ? contextAttempt.value.systemParts : [],
          environment: Exit.isSuccess(contextAttempt) ? contextAttempt.value.environment : null,
          environmentInfo: Exit.isSuccess(contextAttempt) ? contextAttempt.value.environmentInfo : null,
          instructions: Exit.isSuccess(contextAttempt) ? contextAttempt.value.instructions : [],
          tools: Exit.isSuccess(contextAttempt) ? contextAttempt.value.tools : [],
          model: session.model ?? null,
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
          compaction:
            legacyRow && legacySummary && (!compactionRow || legacyRow.time > compactionRow.time)
              ? {
                  reason: legacyRow.auto ? ("auto" as const) : ("manual" as const),
                  summary: legacySummary,
                  recent: "",
                  source: "legacy" as const,
                }
              : compactionMessage && compactionMessage.type === "compaction"
                ? {
                    reason: compactionMessage.reason,
                    summary: compactionMessage.summary,
                    recent: compactionMessage.recent,
                  }
                : null,
        }
      }),
      skillView: Effect.fn("V2Session.skillView")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionSkillCatalog.view(db, sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt,
      skillSlash,
      promptTurn: Effect.fn("V2Session.promptTurn")((input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const admitted = yield* prompt({ ...input, delivery: "queue", resume: false })
            const turn = { sessionID: admitted.sessionID, messageID: admitted.id }
            const cancel = Effect.gen(function* () {
              if (yield* SessionTurn.cancelPending(db, events, turn)) return
              if ((yield* SessionTurn.find(db, turn)) !== undefined) return
              yield* execution.interrupt(admitted.sessionID)
            })
            // Install cancellation cleanup before restoring interruption. The wake ticket
            // follows the generation guaranteed to observe this admission, even when an
            // unrelated active run fails while handing off.
            const exit = yield* restore(execution.wakeAndWait(admitted.sessionID)).pipe(
              Effect.onInterrupt(() => cancel),
              Effect.exit,
            )
            const settled = yield* SessionTurn.find(db, turn)
            if (settled !== undefined) return settled
            if (Exit.isSuccess(exit)) return yield* Effect.die("Session execution completed without settling its input")
            const outcome = Cause.hasInterrupts(exit.cause) ? ("cancelled" as const) : ("failed" as const)
            yield* SessionTurn.settle(db, events, {
              sessionID: admitted.sessionID,
              messageIDs: [admitted.id],
              outcome,
            })
            return outcome
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")((input) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(input.sessionID)
            yield* result.get(input.sessionID)
            yield* events.publish(SessionEvent.AgentSwitched, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              agent: input.agent,
            })
            const session = yield* result.get(input.sessionID)
            yield* activateCatalog(session, location, false)
          }),
        ),
      ),
      switchModel: Effect.fn("V2Session.switchModel")((input) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.gen(function* () {
            yield* requireLocation(input.sessionID)
            const session = yield* result.get(input.sessionID)
            if (
              session.model?.providerID === input.model.providerID &&
              session.model.id === input.model.id &&
              (session.model.variant ?? "default") === (input.model.variant ?? "default")
            )
              return
            yield* events.publish(SessionEvent.ModelSwitched, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              model: input.model,
            })
          }),
        ),
      ),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        yield* requireLocation(input.sessionID)
        yield* execution.compactManual({ sessionID: input.sessionID, model: input.model })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      activate: Effect.fn("V2Session.activate")((sessionID) =>
        activity.withActivity(
          sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(sessionID)
            const session = yield* result.get(sessionID)
            yield* invalidateRuntimeContext(sessionID, location)
            return yield* activateCatalog(session, location, true)
          }),
        ),
      ),
      locationBlockers,
      resume: Effect.fn("V2Session.resume")((sessionID) =>
        activity.withActivity(
          sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(sessionID)
            const session = yield* result.get(sessionID)
            yield* invalidateRuntimeContext(sessionID, location)
            const activation = yield* activateCatalog(session, location, true)
            if (activation.status === "unavailable")
              return yield* new OperationUnavailableError({ operation: "modelContext" })
            yield* SessionTaskResult.reconcile(database, events, sessionID)
            yield* execution.resume(sessionID)
          }),
        ),
      ),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          SessionTaskResult.stop(database, events, sessionID).pipe(Effect.andThen(execution.interrupt(sessionID))),
        ),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")((input) =>
          activity.withActivity(
            input.sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(input.sessionID)
              yield* execution.interrupt(input.sessionID)
              const session = yield* result.get(input.sessionID)
              return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ),
        ),
        clear: Effect.fn("V2Session.revert.clear")((sessionID) =>
          activity.withActivity(
            sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(sessionID)
              yield* execution.interrupt(sessionID)
              const session = yield* result.get(sessionID)
              yield* SessionRevert.clear(session).pipe(
                Effect.provideService(Database.Service, database),
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ),
        ),
        commit: Effect.fn("V2Session.revert.commit")((sessionID) =>
          activity.withActivity(
            sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(sessionID)
              const session = yield* result.get(sessionID)
              yield* SessionRevert.commit(session).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.provideService(Database.Service, database),
              )
            }),
          ),
        ),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: file.mime ?? dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionActivity.node,
    SessionLocationAccess.node,
    SessionLocationMutation.node,
    SessionLocationRuntime.node,
    SyncSetup.node,
  ],
})

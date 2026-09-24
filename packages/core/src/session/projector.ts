export * as SessionProjector from "./projector"

import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { ProjectTable } from "../project/sql"
import { ProjectV2 } from "../project"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { RevertHistory } from "./revert-history"
import { SessionSchema } from "./schema"
import { WorkspaceV2 } from "../workspace"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { AbsolutePath, type DeepMutable } from "../schema"
import { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { SessionPolicyStore } from "./policy"
import { SessionTask } from "./task"
import { SessionTaskResult } from "./task-result"
import { SessionTaskEvent } from "@opencode-ai/schema/session-task-event"
import { SessionTaskDeletionTable, SessionTaskTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    target: info.target ?? null,
    last_known_target_name: info.lastKnownTargetName ?? null,
    portable_target_label: info.portableTargetLabel ?? null,
    sync_space_id: info.syncSpaceID ?? null,
    path: info.path,
    title: info.title,
    approval_mode: info.approvalMode ?? "normal",
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    permission_boundary: info.permissionBoundary,
    subagent_access: info.subagentAccess ?? null,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const db = database.db
    yield* events.project(SessionPolicy.Reviewed, (event) => SessionPolicyStore.project(db, event))
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        // A synced Session may arrive before this device has ever resolved its
        // project. Materialize the minimum parent row required by the Session
        // foreign key; normal project discovery can enrich it later.
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make(event.data.info.projectID),
            worktree: AbsolutePath.make(event.data.info.directory),
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.task) {
          const task = yield* SessionTask.admit(db, event.data.task, {
            validate: false,
            timestamp: event.data.info.time.created,
          })
          if (task && event.data.taskInput) {
            if (!event.durable) return yield* Effect.die("Durable Session event is missing aggregate sequence")
            if (event.data.taskInput.messageID !== task.input_id)
              return yield* Effect.die(new SessionTask.AdmissionConflict())
            yield* SessionInput.projectAdmitted(db, {
              admittedSeq: event.durable.seq,
              id: event.data.taskInput.messageID,
              sessionID: event.data.sessionID,
              prompt: event.data.taskInput.prompt,
              delivery: event.data.taskInput.delivery,
              timeCreated: DateTime.makeUnsafe(event.data.info.time.created),
            })
          }
        }
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionTaskEvent.Admitted, (event) =>
      Effect.gen(function* () {
        const child = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!child) return
        yield* SessionTask.admit(db, event.data.admission, {
          validate: false,
          timestamp: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionTaskEvent.Promoted, (event) =>
      SessionTask.projectPromoted(db, {
        inputID: event.data.inputID,
        childSessionID: event.data.sessionID,
        timestamp: event.data.timestamp,
      }),
    )
    yield* events.project(SessionTaskEvent.Settled, (event) =>
      SessionTask.projectSettled(db, {
        inputID: event.data.inputID,
        childSessionID: event.data.sessionID,
        outcome: event.data.outcome,
        resultMessageID: event.data.resultMessageID,
        timestamp: event.data.timestamp,
        terminalEventID: event.id,
      }),
    )
    yield* events.project(SessionTaskEvent.ArchivedUnknown, (event) =>
      SessionTask.projectArchivedUnknown(db, {
        inputID: event.data.inputID,
        childSessionID: event.data.sessionID,
        operationID: event.data.operationID,
        actorID: event.data.actorID,
        timestamp: event.data.timestamp,
      }),
    )
    yield* events.project(SessionTaskEvent.Reconciled, (event) =>
      SessionTask.projectReconciled(db, {
        childSessionID: event.data.sessionID,
        inputID: event.data.inputID,
        operationID: event.data.operationID,
        actorKind: event.data.actorKind,
        actorID: event.data.actorID,
        disposition: event.data.disposition,
        capacityState: event.data.capacityState,
        timestamp: event.data.timestamp,
        terminalEventID: event.id,
      }),
    )
    yield* events.project(SessionTaskEvent.Stopped, (event) =>
      SessionTask.projectStopped(db, {
        childSessionID: event.data.sessionID,
        rootSessionID: event.data.rootSessionID,
        parentSessionID: event.data.parentSessionID,
        operationID: event.data.operationID,
        intent: event.data.intent,
        actorKind: event.data.actorKind,
        actorID: event.data.actorID,
        members: event.data.members,
        timestamp: event.data.timestamp,
        terminalEventID: event.id,
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) => {
      const {
        directory: _directory,
        target: _target,
        last_known_target_name: _lastKnownTargetName,
        portable_target_label: _portableTargetLabel,
        workspace_id: _workspaceID,
        path: _path,
        revert: _revert,
        ...metadata
      } = sessionRow(event.data.info)
      return Effect.gen(function* () {
        const previous = yield* metadata.permission === undefined
          ? Effect.succeed(undefined)
          : db
              .select({ permission: SessionTable.permission })
              .from(SessionTable)
              .where(eq(SessionTable.id, event.data.sessionID))
              .get()
              .pipe(Effect.orDie)
        const changed =
          previous &&
          SessionPolicyStore.digest(SessionPolicyStore.legacyRules(previous.permission)) !==
            SessionPolicyStore.digest(SessionPolicyStore.legacyRules(metadata.permission))
        yield* db
          .update(SessionTable)
          .set({
            ...metadata,
            ...(changed
              ? {
                  permission_revision: sql`${SessionTable.permission_revision} + 1`,
                  permission_basis_revision: sql`${SessionTable.permission_basis_revision} + 1`,
                }
              : {}),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      })
    })
    // Legacy revert is persisted separately from session metadata so a metadata
    // update can never clear a staged revert boundary.
    yield* events.project(SessionV1.Event.RevertUpdated, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: event.data.revert
            ? { ...event.data.revert, messageID: SessionMessage.ID.make(event.data.revert.messageID) }
            : null,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        const previous = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        const changed =
          previous &&
          SessionPolicyStore.locationKey(SessionPolicyStore.locationFromRow(previous)) !==
            SessionPolicyStore.locationKey(event.data.location)
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            target: event.data.location.target,
            last_known_target_name: event.data.location.lastKnownTargetName ?? null,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
            ...(changed
              ? {
                  permission_revision: sql`${SessionTable.permission_revision} + 1`,
                  permission_basis_revision: sql`${SessionTable.permission_basis_revision} + 1`,
                }
              : {}),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.LocationRebound, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            target: event.data.location.target,
            last_known_target_name: event.data.location.lastKnownTargetName ?? null,
            portable_target_label: null,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            location_revision: event.data.revision,
            permission_basis_revision: sql`${SessionTable.permission_basis_revision} + 1`,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(
            and(eq(SessionTable.id, event.data.sessionID), eq(SessionTable.location_revision, event.data.revision - 1)),
          )
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        yield* db
          .insert(SessionTaskDeletionTable)
          .values({ session_id: event.data.sessionID })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* SessionTask.deleteProjectionForSession(db, event.data.sessionID)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
          origin: event.data.origin,
        })
        yield* SessionTask.projectInboxPromoted(db, {
          inputID: event.data.messageID,
          childSessionID: event.data.sessionID,
          timestamp: DateTime.toEpochMillis(event.data.timestamp),
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        if (event.data.task?.kind === "invocation") {
          const admitted = yield* SessionTask.admit(db, event.data.task.admission, {
            validate: false,
            timestamp: DateTime.toEpochMillis(event.data.timestamp),
          })
          if (!admitted) return
        }
        if (event.data.task?.kind === "steer") {
          const invocation = yield* SessionTask.find(db, event.data.task.invocationInputID)
          if (!invocation || invocation.child_session_id !== event.data.sessionID) return
        }
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
        if (event.data.task?.kind === "steer")
          yield* SessionTask.projectSteerAdmitted(db, {
            inputID: event.data.messageID,
            invocationInputID: event.data.task.invocationInputID,
            operationID: event.data.task.operationID,
            promptDigest: event.data.task.promptDigest,
            timestamp: DateTime.toEpochMillis(event.data.timestamp),
          })
      }),
    )
    yield* events.project(SessionEvent.DelegationResultRecorded, (event) => SessionTaskResult.project(db, event))
    yield* events.project(SessionEvent.DelegationWakeRevoked, (event) => SessionTaskResult.projectRevocation(db, event))
    yield* events.project(SessionEvent.Turn.Settled, () => Effect.void)
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* RevertHistory.boundary(event.data.sessionID, event.data.messageID).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        const session = yield* db
          .select({ revert: SessionTable.revert })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        const partID = session?.revert?.messageID === event.data.messageID ? session.revert.partID : undefined
        const legacy = boundary.messages.flatMap((item) =>
          item.kind === "legacy" && !(partID && String(item.row.id) === event.data.messageID) ? [item.row.id] : [],
        )
        const canonical = boundary.messages.flatMap((item) => (item.kind === "canonical" ? [item.row.id] : []))
        if (partID && boundary.message.kind === "legacy") {
          const parts = yield* db
            .select()
            .from(PartTable)
            .where(
              and(eq(PartTable.message_id, boundary.message.row.id), gte(PartTable.id, SessionV1.PartID.make(partID))),
            )
            .all()
            .pipe(Effect.orDie)
          for (const part of parts) {
            const previous = usage(part.data)
            if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
          }
          if (parts.length)
            yield* db
              .delete(PartTable)
              .where(
                inArray(
                  PartTable.id,
                  parts.map((part) => part.id),
                ),
              )
              .run()
              .pipe(Effect.orDie)
        }
        if (legacy.length) {
          const parts = yield* db
            .select()
            .from(PartTable)
            .where(inArray(PartTable.message_id, legacy))
            .all()
            .pipe(Effect.orDie)
          for (const part of parts) {
            const previous = usage(part.data)
            if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
          }
          yield* db.delete(MessageTable).where(inArray(MessageTable.id, legacy)).run().pipe(Effect.orDie)
        }
        if (canonical.length)
          yield* db
            .delete(SessionMessageTable)
            .where(inArray(SessionMessageTable.id, canonical))
            .run()
            .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(
                inArray(SessionInputTable.id, canonical),
                and(
                  isNull(SessionInputTable.promoted_seq),
                  boundary.message.kind === "canonical"
                    ? gte(SessionInputTable.admitted_seq, boundary.message.row.seq)
                    : gte(SessionInputTable.time_created, boundary.message.row.time_created),
                ),
              ),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })

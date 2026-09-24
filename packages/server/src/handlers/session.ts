import { SessionV2 } from "@opencode-ai/core/session"
import { Cause, DateTime, Effect, Option, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@opencode-ai/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
  SkillMentionError,
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { SessionContextExtension } from "../session-context-extension"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTaskView } from "@opencode-ai/core/session/task-view"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { SessionTaskDelivery } from "@opencode-ai/core/session/task-delivery"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskWait } from "@opencode-ai/core/session/task-wait"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    const taskBackend = Option.getOrElse(
      yield* Effect.serviceOption(SessionTaskCapability.Service),
      () => SessionTaskCapability.legacyTaskPromptOps,
    )
    const contextExtension = yield* Effect.serviceOption(SessionContextExtension.Service)

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              approvalMode: ctx.payload.approvalMode,
              location: ctx.payload.location ?? Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
            }),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.activate",
        Effect.fn(function* (ctx) {
          const current = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const data = yield* session.activate(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          yield* Option.match(contextExtension, {
            onNone: () => Effect.succeed(undefined),
            onSome: (extension) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                return yield* extension.activate({
                  sessionID: ctx.params.sessionID,
                  directory: controllerDirectory(request),
                  agent: current.agent,
                })
              }),
          })
          return {
            data,
          }
        }),
      )
      .handle(
        "session.modelContext",
        Effect.fn(function* (ctx) {
          const modelQuery = ctx.query.model
          const modelOverride = modelQuery
            ? (() => {
                const separator = modelQuery.indexOf("/")
                if (separator === -1) return undefined
                return { providerID: modelQuery.slice(0, separator), modelID: modelQuery.slice(separator + 1) }
              })()
            : undefined
          const subagent = yield* Option.match(contextExtension, {
            onNone: () => Effect.succeed(undefined),
            onSome: (extension) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                return yield* extension.inspect({
                  sessionID: ctx.params.sessionID,
                  directory: controllerDirectory(request),
                  model: modelOverride,
                })
              }),
          })
          const skillView = yield* session.skillView(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const requestContext = yield* session.requestContext(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return {
            data:
              (yield* session.modelContext(ctx.params.sessionID).pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.ContextSnapshotDecodeError", (error) =>
                  Effect.fail(
                    new UnknownError({ message: "Session model context is unreadable", ref: error.sessionID }),
                  ),
                ),
              )) ?? null,
            skillCatalog: skillView?.catalog ?? null,
            skillGuidance: skillView?.guidance ?? null,
            runtimeParts: requestContext?.runtimeParts ?? null,
            systemParts: subagent?.systemParts ?? null,
            agentSystem: requestContext?.agentSystem ?? null,
            environment: requestContext?.environment ?? null,
            environmentInfo: requestContext?.environmentInfo ?? null,
            instructions: requestContext?.instructions ?? [],
            tools: subagent?.tools ?? requestContext?.tools ?? [],
            model: requestContext?.model ?? null,
            headers: requestContext?.headers ?? null,
            compaction: requestContext?.compaction ?? null,
            subagentCatalog: subagent?.subagentCatalog,
            subagentGuidance: subagent?.subagentGuidance,
            subagentRefresh: subagent?.subagentRefresh,
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new InvalidRequestError({
                  message: `Session ${error.operation} is not available`,
                  kind: `session_${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new InvalidRequestError({
                  message: `Session ${error.operation} is not available`,
                  kind: `session_${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.OperationUnavailableError", (error) =>
                  Effect.fail(
                    new InvalidRequestError({
                      message: `Session ${error.operation} is not available`,
                      kind: `session_${error.operation}`,
                    }),
                  ),
                ),
                Effect.catchTag("SkillAdmission.Error", (error) =>
                  Effect.fail(
                    new SkillMentionError({
                      message: `Skill mention could not be admitted: ${error.name}`,
                      kind: error.kind,
                      skillID: error.skillID,
                      name: error.name,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
              Effect.catchTag("Session.OperationUnavailableError", (error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message: `Session ${error.operation} is not available`,
                    kind: `session_${error.operation}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new InvalidRequestError({
                  message: `Session ${error.operation} is not available`,
                  kind: `session_${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new InvalidRequestError({
                  message: `Session ${error.operation} is not available`,
                  kind: `session_${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("session.task.status", (ctx) =>
        Effect.gen(function* () {
          const capability = SessionTaskCapability.evaluate(taskBackend)
          if (capability.status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: `Task control unsupported: ${capability.missing.join(", ")}`,
            })
          const unavailable = () => new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
          const request = ctx.payload
          if (
            (request.target && request.targets) ||
            (request.targets && (request.targets.length === 0 || request.targets.length > 32 || request.cursor)) ||
            (request.limit !== undefined && (request.limit < 1 || request.limit > 32)) ||
            (request.target?.invocation && request.cursor)
          )
            return yield* new InvalidRequestError({ message: "Invalid Task status request" })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.fail(unavailable())))
          const read = SessionTaskView.read(database, {
            parentSessionID: ctx.params.sessionID,
            childSessionID: request.target?.task_id ?? ctx.params.sessionID,
            invocation: request.target?.invocation,
            includeResults: request.include_results,
          })
          const page = request.targets
            ? {
                data: yield* Effect.forEach(request.targets, (target) =>
                  SessionTaskView.read(database, {
                    parentSessionID: ctx.params.sessionID,
                    childSessionID: target.task_id,
                    invocation: target.invocation,
                    includeResults: request.include_results,
                  }),
                ),
              }
            : request.target?.invocation
              ? { data: [yield* read] }
              : request.target
                ? yield* SessionTaskView.invocations(database, {
                    parentSessionID: ctx.params.sessionID,
                    childSessionID: request.target.task_id,
                    cursor: request.cursor,
                    limit: request.limit,
                    includeResults: request.include_results,
                  })
                : yield* SessionTaskView.children(database, {
                    parentSessionID: ctx.params.sessionID,
                    cursor: request.cursor,
                    limit: request.limit,
                    includeResults: request.include_results,
                  })
          const data = yield* Effect.forEach(page.data, (view) =>
            SessionTaskView.withObservedPhase(database, view, locations),
          )
          return { ...page, data }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskView.InvalidCursor
              ? new InvalidCursorError({ message: "Invalid cursor" })
              : error instanceof SessionTaskView.TargetUnavailable
                ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
                : error,
          ),
        ),
      )
      .handle("session.task.send", (ctx) =>
        Effect.gen(function* () {
          const capability = SessionTaskCapability.evaluate(taskBackend)
          if (capability.status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: `Task control unsupported: ${capability.missing.join(", ")}`,
            })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", () =>
                Effect.fail(new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })),
              ),
            )
          const target = ctx.payload.target
          if (target.invocation.parent_session_id !== ctx.params.sessionID)
            return yield* new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
          if (!ctx.payload.operation_id || !ctx.payload.text)
            return yield* new InvalidRequestError({ message: "Invalid Task send request" })
          const receipt = yield* SessionTaskDelivery.send({
            childSessionID: target.task_id,
            invocationInputID: target.input_id,
            invocation: {
              parentSessionID: ctx.params.sessionID,
              parentMessageID: target.invocation.parent_message_id,
              callID: target.invocation.call_id,
            },
            operationID: ctx.payload.operation_id,
            text: ctx.payload.text,
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return { input_id: receipt.inputID, state: receipt.state, reason: receipt.reason }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskDelivery.UnknownOrForbidden
              ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
              : error instanceof SessionTask.AdmissionConflict
                ? new ConflictError({ message: "Task invocation conflict" })
                : error instanceof SessionTaskDelivery.NotRunning
                  ? new ConflictError({ message: "Task is not running" })
                  : error instanceof SessionTaskDelivery.Unavailable
                    ? new ServiceUnavailableError({
                        service: "task_control_unavailable",
                        message: "Task control unavailable",
                      })
                    : error instanceof ServiceUnavailableError ||
                        error instanceof SessionNotFoundError ||
                        error instanceof InvalidRequestError
                      ? error
                      : new ServiceUnavailableError({
                          service: "task_control_unavailable",
                          message: "Task control unavailable",
                        }),
          ),
        ),
      )
      .handle("session.task.reconcile", (ctx) =>
        Effect.gen(function* () {
          const capability = SessionTaskCapability.evaluate(taskBackend)
          if (capability.status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: `Task control unsupported: ${capability.missing.join(", ")}`,
            })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", () =>
                Effect.fail(new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })),
              ),
            )
          const target = ctx.payload.target
          if (target.invocation.parent_session_id !== ctx.params.sessionID)
            return yield* new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
          if (!ctx.payload.operation_id)
            return yield* new InvalidRequestError({ message: "Invalid Task reconcile request" })
          const receipt = yield* SessionTaskDelivery.reconcile({
            childSessionID: target.task_id,
            inputID: target.input_id,
            invocation: {
              parentSessionID: ctx.params.sessionID,
              parentMessageID: target.invocation.parent_message_id,
              callID: target.invocation.call_id,
            },
            operationID: ctx.payload.operation_id,
            actor: { kind: "user", id: "instance-user" },
            disposition: ctx.payload.disposition,
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return {
            input_id: receipt.inputID,
            disposition: receipt.disposition,
            eligibility: receipt.eligibility,
            capacity_state: receipt.capacityState,
          }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskDelivery.UnknownOrForbidden
              ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
              : error instanceof SessionTask.AdmissionConflict
                ? new ConflictError({ message: "Task invocation conflict" })
                : error instanceof SessionTaskDelivery.Unavailable
                  ? new ServiceUnavailableError({
                      service: "task_control_unavailable",
                      message: "Task control unavailable",
                    })
                  : error instanceof ServiceUnavailableError ||
                      error instanceof SessionNotFoundError ||
                      error instanceof InvalidRequestError
                    ? error
                    : new ServiceUnavailableError({
                        service: "task_control_unavailable",
                        message: "Task control unavailable",
                      }),
          ),
        ),
      )
      .handle("session.taskWait", (ctx) =>
        Effect.gen(function* () {
          const capability = SessionTaskCapability.evaluate(taskBackend)
          if (capability.status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: `Task control unsupported: ${capability.missing.join(", ")}`,
            })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", () =>
                Effect.fail(new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })),
              ),
            )
          return yield* SessionTaskWait.wait({
            parentSessionID: ctx.params.sessionID,
            targets: ctx.payload.targets,
            until: ctx.payload.until,
            timeoutMs: ctx.payload.timeout_ms,
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(LocationServiceMap.Service, locations),
          )
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskWait.UnknownOrForbidden
              ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
              : error instanceof SessionTaskWait.InvalidRequest
                ? new InvalidRequestError({ message: "Invalid Task wait request" })
                : error instanceof ServiceUnavailableError || error instanceof SessionNotFoundError
                  ? error
                  : new ServiceUnavailableError({
                      service: "task_wait_unavailable",
                      message: "Task wait unavailable",
                    }),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.fail(
              error instanceof SessionNotFoundError ||
                error instanceof InvalidRequestError ||
                error instanceof ServiceUnavailableError
                ? error
                : new ServiceUnavailableError({
                    service: "task_wait_unavailable",
                    message: "Task wait unavailable",
                  }),
            )
          }),
        ),
      )
      .handle("session.taskInterrupt", (ctx) =>
        Effect.gen(function* () {
          if (SessionTaskCapability.evaluate(taskBackend).status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: "Task control unsupported",
            })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", () =>
                Effect.fail(new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })),
              ),
            )
          if (ctx.payload.target.invocation.parent_session_id !== ctx.params.sessionID)
            return yield* new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
          const receipt = yield* SessionTaskControl.interrupt({
            childSessionID: ctx.payload.target.task_id,
            inputID: ctx.payload.target.input_id,
            invocation: {
              parentSessionID: ctx.params.sessionID,
              parentMessageID: ctx.payload.target.invocation.parent_message_id,
              callID: ctx.payload.target.invocation.call_id,
            },
            actor: { kind: "user", id: "instance-user" },
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return { input_id: receipt.inputID, state: receipt.state }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskControl.UnknownOrForbidden
              ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
              : error instanceof SessionTaskControl.Conflict
                ? new ConflictError({ message: "Task invocation conflict" })
                : error instanceof SessionNotFoundError || error instanceof ServiceUnavailableError
                  ? error
                  : new ServiceUnavailableError({
                      service: "task_control_unavailable",
                      message: "Task control unavailable",
                    }),
          ),
        ),
      )
      .handle("session.taskStop", (ctx) =>
        Effect.gen(function* () {
          if (SessionTaskCapability.evaluate(taskBackend).status === "unsupported")
            return yield* new ServiceUnavailableError({
              service: "task_control_unsupported",
              message: "Task control unsupported",
            })
          yield* session
            .get(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", () =>
                Effect.fail(new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })),
              ),
            )
          if (!ctx.payload.operation_id) return yield* new InvalidRequestError({ message: "Missing operation ID" })
          const receipt = yield* SessionTaskControl.stop({
            parentSessionID: ctx.params.sessionID,
            childSessionID: ctx.payload.task_id,
            operationID: ctx.payload.operation_id,
            actor: { kind: "user", id: "instance-user" },
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(SessionExecution.Service, execution),
          )
          return {
            operation_id: receipt.operationID,
            data: receipt.data.map((member) => ({ input_id: member.inputID, state: member.state })),
          }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SessionTaskControl.UnknownOrForbidden
              ? new SessionNotFoundError({ sessionID: "", message: "Task target unavailable" })
              : error instanceof SessionTaskControl.Conflict
                ? new ConflictError({ message: "Task invocation conflict" })
                : error instanceof SessionNotFoundError ||
                    error instanceof InvalidRequestError ||
                    error instanceof ServiceUnavailableError
                  ? error
                  : new ServiceUnavailableError({
                      service: "task_control_unavailable",
                      message: "Task control unavailable",
                    }),
          ),
        ),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)

function controllerDirectory(request: HttpServerRequest.HttpServerRequest) {
  const directory = request.headers["x-opencode-directory"]
  if (!directory) return process.cwd()
  try {
    return decodeURIComponent(directory)
  } catch {
    return directory
  }
}

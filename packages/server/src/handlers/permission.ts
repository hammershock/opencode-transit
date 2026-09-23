import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import {
  ConflictError,
  InvalidRequestError,
  PermissionNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "@opencode-ai/protocol/errors"
import { SessionPolicyAccess } from "@opencode-ai/core/session/policy-access"
import type { SessionPolicyStore } from "@opencode-ai/core/session/policy"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { response } from "../location"

function missingRequest(id: PermissionV2.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    const policies = yield* SessionPolicyAccess.Service
    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          return yield* response((yield* PermissionV2.Service).list())
        }),
      )
      .handle(
        "session.permission.create",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          return {
            data: yield* permission
              .ask({
                id: ctx.payload.id,
                sessionID: ctx.params.sessionID,
                action: ctx.payload.action,
                resources: ctx.payload.resources,
                save: ctx.payload.save,
                metadata: ctx.payload.metadata,
                source: ctx.payload.source,
                agent: ctx.payload.agent,
              })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag(
                  "SessionPolicy.Failure",
                  (error) => new ServiceUnavailableError({ message: error.message, service: "session.policy" }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          return { data: yield* permission.forSession(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.permission.get",
        Effect.fn(function* (ctx) {
          const request = yield* (yield* PermissionV2.Service).get(ctx.params.requestID)
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          return { data: request }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          const request = yield* permission.get(ctx.params.requestID)
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          yield* permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(
              Effect.catchTag("PermissionV2.NotFoundError", () => missingRequest(ctx.params.requestID)),
              Effect.catchTag(
                "SessionPolicy.Failure",
                (error) => new ServiceUnavailableError({ message: error.message, service: "session.policy" }),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return {
            data: yield* (yield* PermissionSaved.Service).list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        "session.policy.inspect",
        Effect.fn(function* (ctx) {
          return {
            data: yield* policies
              .inspect(ctx.params.sessionID)
              .pipe(
                Effect.catchTag("SessionPolicy.Failure", (error) =>
                  Effect.fail(policyError(ctx.params.sessionID, error)),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.policy.review",
        Effect.fn(function* (ctx) {
          return {
            data: yield* policies
              .review({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(
                Effect.catchTag("SessionPolicy.Failure", (error) =>
                  Effect.fail(policyError(ctx.params.sessionID, error)),
                ),
              ),
          }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          yield* (yield* PermissionSaved.Service).remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

function policyError(sessionID: SessionSchema.ID, error: SessionPolicyStore.Failure) {
  if (error.kind === "not-found") return new SessionNotFoundError({ sessionID, message: error.message })
  if (error.kind === "conflict") return new ConflictError({ message: error.message, resource: "session.policy" })
  if (error.kind === "invalid-review") return new InvalidRequestError({ message: error.message, kind: "policy-review" })
  return new ServiceUnavailableError({ message: error.message, service: "session.policy" })
}

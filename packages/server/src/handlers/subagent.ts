import { Location } from "@opencode-ai/core/location"
import { SubagentMutationError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { SubagentManager } from "../subagent"

export const SubagentHandler = HttpApiBuilder.group(Api, "server.subagent", (handlers) =>
  Effect.gen(function* () {
    const manager = yield* SubagentManager.Service
    const location = Effect.map(Location.Service, (location) => ({
      directory: location.directory,
      target: location.target,
    }))
    const mutation = <A>(
      effect: (input: {
        directory: string
        target?: Location.Target
      }) => Effect.Effect<A, SubagentManager.MutationFailure>,
    ) =>
      Effect.flatMap(location, effect).pipe(
        Effect.mapError(
          (error) =>
            new SubagentMutationError({
              kind: error.kind,
              message: error.message,
              revision: error.revision,
            }),
        ),
      )

    return handlers
      .handle("subagent.catalog", (ctx) =>
        response(
          Effect.flatMap(location, (location) =>
            manager.catalog({
              directory: location.directory,
              target: location.target,
              sessionID: ctx.query.sessionID,
              parentAgentID: ctx.query.parentAgentID,
              includeInactive: ctx.query.includeInactive !== "false",
            }),
          ),
        ),
      )
      .handle("subagent.definition.create", (ctx) =>
        response(
          mutation((location) =>
            manager.create({ directory: location.directory, target: location.target, ...ctx.payload }),
          ),
        ),
      )
      .handle("subagent.definition.update", (ctx) =>
        response(
          mutation((location) =>
            manager.update({
              directory: location.directory,
              target: location.target,
              ...ctx.payload,
              subagentID: ctx.params.subagentID,
            }),
          ),
        ),
      )
      .handle("subagent.definition.remove", (ctx) =>
        response(
          mutation((location) =>
            manager.remove({
              directory: location.directory,
              target: location.target,
              ...ctx.payload,
              subagentID: ctx.params.subagentID,
            }),
          ),
        ),
      )
      .handle("subagent.access.update", (ctx) =>
        response(
          mutation((location) =>
            manager.setAccess({ directory: location.directory, target: location.target, ...ctx.payload }),
          ),
        ),
      )
  }),
)

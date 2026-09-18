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
    const directory = Effect.map(Location.Service, (location) => location.directory)
    const mutation = <A>(effect: (directory: string) => Effect.Effect<A, SubagentManager.MutationFailure>) =>
      Effect.flatMap(directory, effect).pipe(
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
          Effect.flatMap(directory, (directory) =>
            manager.catalog({
              directory,
              sessionID: ctx.query.sessionID,
              parentAgentID: ctx.query.parentAgentID,
              includeInactive: ctx.query.includeInactive !== "false",
            }),
          ),
        ),
      )
      .handle("subagent.definition.create", (ctx) =>
        response(mutation((directory) => manager.create({ directory, ...ctx.payload }))),
      )
      .handle("subagent.definition.update", (ctx) =>
        response(
          mutation((directory) => manager.update({ directory, ...ctx.payload, subagentID: ctx.params.subagentID })),
        ),
      )
      .handle("subagent.definition.remove", (ctx) =>
        response(
          mutation((directory) => manager.remove({ directory, ...ctx.payload, subagentID: ctx.params.subagentID })),
        ),
      )
      .handle("subagent.access.update", (ctx) =>
        response(mutation((directory) => manager.setAccess({ directory, ...ctx.payload }))),
      )
  }),
)

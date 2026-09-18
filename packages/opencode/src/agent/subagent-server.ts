import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { SubagentManager } from "@opencode-ai/server/subagent"
import { Effect, Layer } from "effect"
import { Subagent } from "./subagent"

export const subagentManagerLayer = Layer.effect(
  SubagentManager.Service,
  Effect.gen(function* () {
    const subagent = yield* Subagent.Service
    const instances = yield* InstanceStore.Service
    const provide = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory }, effect)
    const mutation = <A>(
      directory: string,
      effect: Effect.Effect<A, Subagent.ConflictError | Subagent.NotFoundError | Subagent.ReadonlyError>,
    ) => provide(directory, effect).pipe(Effect.mapError(mutationFailure))

    return SubagentManager.Service.of({
      catalog: (input) =>
        provide(
          input.directory,
          subagent.resolve({
            parentAgentID: input.parentAgentID,
            sessionID: input.sessionID ? SessionID.make(input.sessionID) : undefined,
            includeInactive: input.includeInactive,
          }),
        ),
      create: (input) =>
        mutation(
          input.directory,
          subagent.create({
            sessionID: SessionID.make(input.sessionID),
            parentAgentID: input.parentAgentID,
            expectedRevision: input.expectedRevision,
            definition: input.definition,
          }),
        ),
      update: (input) =>
        mutation(
          input.directory,
          subagent.update({
            sessionID: SessionID.make(input.sessionID),
            parentAgentID: input.parentAgentID,
            subagentID: input.subagentID,
            expectedRevision: input.expectedRevision,
            definition: input.definition,
          }),
        ),
      remove: (input) =>
        mutation(
          input.directory,
          subagent.remove({
            sessionID: SessionID.make(input.sessionID),
            parentAgentID: input.parentAgentID,
            subagentID: input.subagentID,
            expectedRevision: input.expectedRevision,
          }),
        ),
      setAccess: (input) => {
        const access = {
          sessionID: SessionID.make(input.sessionID),
          parentAgentID: input.parentAgentID,
          subagentID: input.subagentID,
          active: input.active,
          expectedRevision: input.expectedRevision,
        }
        return mutation(
          input.directory,
          input.scope === "global" ? subagent.setGlobalAccess(access) : subagent.setSessionAccess(access),
        )
      },
    })
  }),
)

function mutationFailure(error: Subagent.ConflictError | Subagent.NotFoundError | Subagent.ReadonlyError) {
  if (error instanceof Subagent.ConflictError)
    return new SubagentManager.MutationFailure({
      kind: "conflict",
      message: "The subagent catalog changed. Reload and retry.",
      revision: error.actualRevision,
    })
  if (error instanceof Subagent.ReadonlyError)
    return new SubagentManager.MutationFailure({ kind: "readonly", message: `Subagent ${error.id} is read-only.` })
  return new SubagentManager.MutationFailure({ kind: "not-found", message: `Subagent ${error.id} was not found.` })
}

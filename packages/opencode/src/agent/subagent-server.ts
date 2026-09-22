import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { SubagentManager } from "@opencode-ai/server/subagent"
import type { Location } from "@opencode-ai/core/location"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer } from "effect"
import { Subagent } from "./subagent"

type Located = { directory: string; target?: Location.Target; workspaceID?: WorkspaceV2.ID }

export const subagentManagerLayer = Layer.effect(
  SubagentManager.Service,
  Effect.gen(function* () {
    const subagent = yield* Subagent.Service
    const instances = yield* InstanceStore.Service
    const provide = <A, E, R>(input: Located, effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory: input.directory, target: input.target, workspaceID: input.workspaceID }, effect)
    const mutation = <A>(
      input: Located,
      effect: Effect.Effect<A, Subagent.ConflictError | Subagent.NotFoundError | Subagent.ReadonlyError>,
    ) => provide(input, effect).pipe(Effect.mapError(mutationFailure))

    return SubagentManager.Service.of({
      catalog: (input) =>
        provide(
          input,
          subagent.resolve({
            parentAgentID: input.parentAgentID,
            sessionID: input.sessionID ? SessionID.make(input.sessionID) : undefined,
            includeInactive: input.includeInactive,
          }),
        ),
      create: (input) =>
        mutation(
          input,
          subagent.create({
            sessionID: SessionID.make(input.sessionID),
            parentAgentID: input.parentAgentID,
            expectedRevision: input.expectedRevision,
            definition: input.definition,
          }),
        ),
      update: (input) =>
        mutation(
          input,
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
          input,
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
          input,
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

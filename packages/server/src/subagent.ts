export * as SubagentManager from "./subagent"

import { Subagent } from "@opencode-ai/schema/subagent"
import type { Location } from "@opencode-ai/core/location"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Context, Data, Effect, Layer } from "effect"

export class MutationFailure extends Data.TaggedError("SubagentManagerMutationFailure")<{
  kind: "conflict" | "not-found" | "readonly"
  message: string
  revision?: string
}> {}

type Located<Input> = Input & { directory: string; target?: Location.Target; workspaceID?: WorkspaceV2.ID }

export interface Interface {
  readonly catalog: (input: {
    directory: string
    target?: Location.Target
    workspaceID?: WorkspaceV2.ID
    sessionID?: string
    parentAgentID: string
    includeInactive?: boolean
  }) => Effect.Effect<Subagent.Snapshot>
  readonly create: (
    input: Located<typeof Subagent.DefinitionCreate.Type>,
  ) => Effect.Effect<Subagent.Snapshot, MutationFailure>
  readonly update: (
    input: Located<typeof Subagent.DefinitionUpdate.Type>,
  ) => Effect.Effect<Subagent.Snapshot, MutationFailure>
  readonly remove: (
    input: Located<typeof Subagent.DefinitionRemove.Type>,
  ) => Effect.Effect<Subagent.Snapshot, MutationFailure>
  readonly setAccess: (
    input: Located<typeof Subagent.AccessUpdate.Type>,
  ) => Effect.Effect<Subagent.Snapshot, MutationFailure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentManager") {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    catalog: (input) =>
      Effect.succeed({
        revision: "unavailable",
        parentAgentID: input.parentAgentID,
        sessionID: input.sessionID,
        entries: [],
        diagnostics: ["Subagent management is unavailable in this server runtime."],
      }),
    create: () => Effect.fail(unavailable()),
    update: () => Effect.fail(unavailable()),
    remove: () => Effect.fail(unavailable()),
    setAccess: () => Effect.fail(unavailable()),
  }),
)

function unavailable() {
  return new MutationFailure({ kind: "readonly", message: "Subagent management is unavailable." })
}

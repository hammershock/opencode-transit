export * as Subagent from "./subagent"

import { Schema } from "effect"
import { optional, PositiveInt } from "./schema"

const PermissionAction = Schema.Literals(["ask", "allow", "deny"])
const PermissionRule = Schema.Union([PermissionAction, Schema.Record(Schema.String, PermissionAction)])
export const PermissionConfig = Schema.Record(Schema.String, PermissionRule).annotate({
  identifier: "Subagent.PermissionConfig",
})

export const DefinitionDraft = Schema.Struct({
  name: Schema.NonEmptyString,
  model: Schema.String.pipe(optional),
  variant: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  prompt: Schema.String.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permission: PermissionConfig.pipe(optional),
}).annotate({ identifier: "Subagent.DefinitionDraft" })
export type DefinitionDraft = typeof DefinitionDraft.Type

export const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String.pipe(optional),
  variant: Schema.String.pipe(optional),
  prompt: Schema.String.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permission: PermissionConfig.pipe(optional),
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }).pipe(optional),
  effective: Schema.Literals(["active", "inactive"]),
  reason: Schema.Literals(["default", "global", "session", "permission", "parent-disabled"]),
  approvalRequired: Schema.Boolean,
  capabilities: Schema.Array(Schema.String),
  editable: Schema.Boolean,
  source: Schema.Literals(["builtin", "global", "compatibility"]),
}).annotate({ identifier: "Subagent.Entry" })
export type Entry = typeof Entry.Type

export const Snapshot = Schema.Struct({
  revision: Schema.String,
  parentAgentID: Schema.String,
  sessionID: Schema.String.pipe(optional),
  entries: Schema.Array(Entry),
  diagnostics: Schema.Array(Schema.String),
}).annotate({ identifier: "Subagent.Snapshot" })
export type Snapshot = typeof Snapshot.Type

export const MutationContext = Schema.Struct({
  sessionID: Schema.String,
  parentAgentID: Schema.String,
  expectedRevision: Schema.String,
}).annotate({ identifier: "Subagent.MutationContext" })

export const DefinitionCreate = Schema.Struct({
  ...MutationContext.fields,
  definition: DefinitionDraft,
}).annotate({ identifier: "Subagent.DefinitionCreate" })

export const DefinitionUpdatePayload = Schema.Struct({
  ...MutationContext.fields,
  definition: DefinitionDraft,
}).annotate({ identifier: "Subagent.DefinitionUpdatePayload" })

export const DefinitionUpdate = Schema.Struct({
  ...DefinitionUpdatePayload.fields,
  subagentID: Schema.String,
}).annotate({ identifier: "Subagent.DefinitionUpdate" })

export const DefinitionRemove = Schema.Struct({
  ...MutationContext.fields,
  subagentID: Schema.String,
}).annotate({ identifier: "Subagent.DefinitionRemove" })

export const AccessUpdate = Schema.Struct({
  ...DefinitionRemove.fields,
  active: Schema.Boolean,
  scope: Schema.Literals(["session", "global"]),
}).annotate({ identifier: "Subagent.AccessUpdate" })

export * as Harness from "./harness"

import { Schema } from "effect"
import { Location } from "./location"
import { AbsolutePath, NonNegativeInt, optional } from "./schema"

export const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("Harness.Revision"))
export type Revision = typeof Revision.Type

export const InstructionTarget = Schema.Union([Schema.Literal("local"), Location.TargetID]).annotate({
  identifier: "Harness.InstructionTarget",
})
export type InstructionTarget = typeof InstructionTarget.Type

export const InstructionScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("global") }),
  Schema.Struct({ type: Schema.Literal("target"), target: InstructionTarget }),
]).annotate({ identifier: "Harness.InstructionScope" })
export type InstructionScope = typeof InstructionScope.Type

export const InstructionBinding = Schema.Struct({
  target: InstructionTarget,
  reference: Schema.NonEmptyString,
}).annotate({ identifier: "Harness.InstructionBinding" })
export type InstructionBinding = typeof InstructionBinding.Type

export const InstructionSettingsDiagnostic = Schema.Struct({
  kind: Schema.Literals(["invalid-config", "unsupported-version", "invalid-target", "invalid-reference"]),
  field: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "Harness.InstructionSettingsDiagnostic" })
export type InstructionSettingsDiagnostic = typeof InstructionSettingsDiagnostic.Type

export const InstructionSettingsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  path: AbsolutePath,
  home: optional(AbsolutePath),
  revision: Revision,
  global: optional(Schema.NonEmptyString),
  targets: Schema.Array(InstructionBinding),
  diagnostics: Schema.Array(InstructionSettingsDiagnostic),
  valid: Schema.Boolean,
}).annotate({ identifier: "Harness.InstructionSettingsSnapshot" })
export type InstructionSettingsSnapshot = typeof InstructionSettingsSnapshot.Type

export const InstructionFileStatus = Schema.Literals(["readable", "missing", "unreadable"])
export type InstructionFileStatus = typeof InstructionFileStatus.Type

export const InstructionSource = Schema.Struct({
  reference: Schema.NonEmptyString,
  resolved: AbsolutePath,
  status: InstructionFileStatus,
  content: optional(Schema.String),
  size: optional(NonNegativeInt),
  digest: optional(Schema.String),
  truncated: optional(Schema.Boolean),
  diagnostic: optional(Schema.String),
  sharedTargets: Schema.Array(InstructionTarget),
}).annotate({ identifier: "Harness.InstructionSource" })
export type InstructionSource = typeof InstructionSource.Type

export const InstructionRead = Schema.Struct({
  scope: InstructionScope,
  mode: Schema.Literals(["default", "custom", "unset", "invalid"]),
  source: optional(InstructionSource),
  diagnostics: Schema.Array(InstructionSettingsDiagnostic),
}).annotate({ identifier: "Harness.InstructionRead" })
export type InstructionRead = typeof InstructionRead.Type

export const InstructionBindInput = Schema.Struct({
  scope: InstructionScope,
  reference: Schema.NonEmptyString,
  expectedRevision: Revision,
}).annotate({ identifier: "Harness.InstructionBindInput" })
export type InstructionBindInput = typeof InstructionBindInput.Type

export const InstructionTargetMutationInput = Schema.Struct({
  target: InstructionTarget,
  expectedRevision: Revision,
}).annotate({ identifier: "Harness.InstructionTargetMutationInput" })
export type InstructionTargetMutationInput = typeof InstructionTargetMutationInput.Type

export const InstructionRevisionInput = Schema.Struct({
  expectedRevision: Revision,
}).annotate({ identifier: "Harness.InstructionRevisionInput" })
export type InstructionRevisionInput = typeof InstructionRevisionInput.Type

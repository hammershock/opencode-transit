import { Harness } from "@opencode-ai/schema/harness"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, UnknownError } from "../errors"

const mutationErrors = [ConflictError, InvalidRequestError, UnknownError] as const

export const HarnessGroup = HttpApiGroup.make("server.harness")
  .add(
    HttpApiEndpoint.get("harness.instructions.settings", "/api/harness/instructions", {
      success: Harness.InstructionSettingsSnapshot,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.settings",
        summary: "Read device-local harness instruction settings",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("harness.instructions.global", "/api/harness/instructions/global", {
      success: Harness.InstructionRead,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.global",
        summary: "Inspect the controller-global instruction selection",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("harness.instructions.target", "/api/harness/instructions/target/:target", {
      params: { target: Harness.InstructionTarget },
      success: Harness.InstructionRead,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.target",
        summary: "Inspect one controller-side target instruction selection",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("harness.instructions.validate", "/api/harness/instructions/validate", {
      payload: Schema.Struct({ reference: Schema.NonEmptyString }),
      success: Harness.InstructionSource,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.validate",
        summary: "Validate and preview one controller instruction file",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("harness.instructions.bind", "/api/harness/instructions/binding", {
      payload: Harness.InstructionBindInput,
      success: Harness.InstructionSettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.bind",
        summary: "Bind a global or target instruction file",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("harness.instructions.resetGlobal", "/api/harness/instructions/global/reset", {
      payload: Harness.InstructionRevisionInput,
      success: Harness.InstructionSettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.global.reset",
        summary: "Reset controller-global instructions to default discovery",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("harness.instructions.unbind", "/api/harness/instructions/target/unbind", {
      payload: Harness.InstructionTargetMutationInput,
      success: Harness.InstructionSettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.harness.instructions.target.unbind",
        summary: "Unbind a target without deleting its shared instruction file",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "harness",
      description: "Device-local harness configuration.",
    }),
  )

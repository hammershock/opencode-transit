import { HarnessInstructions } from "@opencode-ai/core/harness/instructions"
import { ConflictError, InvalidRequestError, UnknownError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const PreviewCharacters = 16_384

const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause): unknown => cause }).pipe(Effect.mapError(mapDomainError))

const read = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new UnknownError({ message: "Harness instruction settings operation failed", ref: "harness" }),
  })

function mapDomainError(cause: unknown) {
  if (cause instanceof HarnessInstructions.RevisionConflictError)
    return new ConflictError({ message: "Harness settings revision changed", resource: "harness.jsonc" })
  if (cause instanceof HarnessInstructions.InvalidConfigError)
    return new InvalidRequestError({ message: "Harness settings configuration is invalid", kind: "harness_settings" })
  if (cause instanceof HarnessInstructions.InvalidReferenceError)
    return new InvalidRequestError({ message: "Instruction file reference is invalid", kind: "instruction_reference" })
  return new UnknownError({ message: "Harness instruction settings operation failed", ref: "harness" })
}

type InstructionSource = Awaited<ReturnType<HarnessInstructions.Interface["validate"]>>
type InstructionRead = Awaited<ReturnType<HarnessInstructions.Interface["read"]>>

export function boundedSource(source: InstructionSource): InstructionSource {
  if (source.content === undefined || source.content.length <= PreviewCharacters) return source
  return {
    ...source,
    content: source.content.slice(0, PreviewCharacters),
    truncated: true,
  }
}

function boundedRead(value: InstructionRead): InstructionRead {
  return {
    ...value,
    source: value.source ? boundedSource(value.source) : undefined,
  }
}

export const HarnessHandler = HttpApiBuilder.group(Api, "server.harness", (handlers) =>
  Effect.gen(function* () {
    const instructions = yield* HarnessInstructions.Service
    return handlers
      .handle("harness.instructions.settings", () => read(instructions.list))
      .handle("harness.instructions.global", () =>
        read(() => instructions.read({ type: "global" })).pipe(Effect.map(boundedRead)),
      )
      .handle("harness.instructions.target", (ctx) =>
        read(() => instructions.read({ type: "target", target: ctx.params.target })).pipe(Effect.map(boundedRead)),
      )
      .handle("harness.instructions.validate", (ctx) =>
        invoke(() => instructions.validate(ctx.payload.reference)).pipe(Effect.map(boundedSource)),
      )
      .handle("harness.instructions.bind", (ctx) => invoke(() => instructions.bind(ctx.payload)))
      .handle("harness.instructions.resetGlobal", (ctx) =>
        invoke(() => instructions.resetGlobal(ctx.payload.expectedRevision)),
      )
      .handle("harness.instructions.unbind", (ctx) => invoke(() => instructions.unbind(ctx.payload)))
  }),
)

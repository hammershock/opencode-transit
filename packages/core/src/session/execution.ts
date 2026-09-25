export * as SessionExecution from "./execution"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"
import { ModelV2 } from "../model"
import { SessionCompaction } from "./compaction"
import { SessionRunnerModel } from "./runner/model"
import { MessageDecodeError } from "./error"

export class CompactionBusyError extends Schema.TaggedErrorClass<CompactionBusyError>()(
  "SessionExecution.CompactionBusyError",
  { sessionID: SessionSchema.ID },
) {}

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Registers work and waits for the execution generation guaranteed to observe it. */
  readonly wakeAndWait: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  readonly compactManual: (input: {
    sessionID: SessionSchema.ID
    model?: ModelV2.Ref
  }) => Effect.Effect<
    void,
    CompactionBusyError | SessionRunnerModel.Error | MessageDecodeError | SessionCompaction.ManualError
  >
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly generation: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
  readonly interruptGeneration: (
    sessionID: SessionSchema.ID,
    generation: string,
  ) => Effect.Effect<"interrupted" | "completed" | "stale">
  /** Signal only the bound invocation generation. This never waits for settlement. */
  readonly requestInterruptExact: (
    sessionID: SessionSchema.ID,
    inputID: string,
    ownerGeneration: string,
  ) => Effect.Effect<boolean>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    wakeAndWait: () => Effect.void,
    compactManual: () => Effect.void,
    interrupt: () => Effect.void,
    generation: () => Effect.succeed(undefined),
    interruptGeneration: () => Effect.succeed("stale"),
    requestInterruptExact: () => Effect.succeed(false),
  }),
)

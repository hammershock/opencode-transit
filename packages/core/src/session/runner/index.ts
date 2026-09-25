export * as SessionRunner from "./index"

import type { LLMError } from "@opencode-ai/llm"
import { Context, Effect } from "effect"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"
import type { ModelV2 } from "../../model"
import type { SessionCompaction } from "../compaction"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  readonly compactManual: (input: {
    readonly sessionID: SessionSchema.ID
    readonly model?: ModelV2.Ref
  }) => Effect.Effect<void, SessionRunnerModel.Error | MessageDecodeError | SessionCompaction.ManualError>
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    /** A Task-owned drain executes only this invocation; the next one needs a new owner lease. */
    readonly taskInputID?: string
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunner") {}

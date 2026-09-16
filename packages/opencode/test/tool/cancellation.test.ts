import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { Truncate } from "@/tool/truncate"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(FSUtil.node), Layer.mock(Agent.Service, {}), Layer.mock(Truncate.Service, {})),
)

for (const name of ["glob", "grep"] as const) {
  for (const phase of ["stat", "ripgrep"] as const) {
    it.instance(`${name} cancellation interrupts ${phase} and forwards its signal`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<AbortSignal | undefined>()
        const released = yield* Deferred.make<void>()
        const abort = new AbortController()
        const blocked = (signal?: AbortSignal) =>
          Deferred.succeed(started, signal).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(released, undefined)),
          )
        const fs = yield* FSUtil.Service
        const overrides = Layer.mergeAll(
          Layer.succeed(FSUtil.Service, { ...fs, stat: (path) => (phase === "stat" ? blocked() : fs.stat(path)) }),
          Layer.mock(Ripgrep.Service, {
            glob: (input) => blocked(input.signal),
            grep: (input) => blocked(input.signal),
          }),
        )
        const info =
          name === "glob"
            ? yield* GlobTool.pipe(Effect.provide(overrides))
            : yield* GrepTool.pipe(Effect.provide(overrides))
        const leaf = yield* info.init()
        const bridge = yield* EffectBridge.make()
        const pending = bridge
          .promise<unknown, never, never>(
            leaf.execute(
              { pattern: "*.ts" },
              {
                sessionID: SessionID.make("ses_cancel"),
                messageID: MessageID.make("msg_cancel"),
                agent: "build",
                abort: abort.signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            ),
            { signal: abort.signal },
          )
          .catch(() => "cancelled")
        expect(yield* Deferred.await(started)).toBe(phase === "ripgrep" ? abort.signal : undefined)
        abort.abort()
        expect(yield* Effect.promise(() => pending).pipe(Effect.timeout("2 seconds"))).toBe("cancelled")
        yield* Deferred.await(released)
      }),
    )
  }
}

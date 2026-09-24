import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { waitForAbort } from "@opencode-ai/core/process"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { Truncate } from "@/tool/truncate"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { MAX_TIMEOUT_MS, Timeout } from "@/tool/search-timeout"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(FSUtil.node), Layer.mock(Agent.Service, {}), Layer.mock(Truncate.Service, {})),
)

it.live("search timeout schema rejects invalid and excessive values", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownSync(Timeout)
    expect(() => decode(0)).toThrow()
    expect(() => decode(MAX_TIMEOUT_MS + 1)).toThrow()
    expect(decode(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS)
  }),
)

for (const name of ["glob", "grep"] as const) {
  it.instance(`${name} enforces a declared absolute search timeout`, () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>()
      const fs = yield* FSUtil.Service
      const overrides = Layer.mergeAll(
        Layer.succeed(FSUtil.Service, fs),
        Layer.mock(Ripgrep.Service, {
          glob: (input) =>
            waitForAbort(input.signal!).pipe(
              Effect.mapError(() => new Ripgrep.Error({ message: "aborted" })),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
          grep: (input) =>
            waitForAbort(input.signal!).pipe(
              Effect.mapError(() => new Ripgrep.Error({ message: "aborted" })),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
        }),
      )
      const ctx = {
        sessionID: SessionID.make("ses_timeout"),
        messageID: MessageID.make("msg_timeout"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const call =
        name === "glob"
          ? GlobTool.pipe(
              Effect.provide(overrides),
              Effect.flatMap((info) => info.init()),
              Effect.flatMap((leaf) => leaf.execute({ pattern: "*.ts", timeout: 20 }, ctx)),
              Effect.asVoid,
            )
          : GrepTool.pipe(
              Effect.provide(overrides),
              Effect.flatMap((info) => info.init()),
              Effect.flatMap((leaf) => leaf.execute({ pattern: "*.ts", timeout: 20 }, ctx)),
              Effect.asVoid,
            )
      const exit = yield* Effect.exit(call)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("Search timed out after 20 ms")
      yield* Deferred.await(released).pipe(Effect.timeout("2 seconds"))
    }),
  )

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
        const signal = yield* Deferred.await(started)
        if (phase === "ripgrep") expect(signal).toBeInstanceOf(AbortSignal)
        else expect(signal).toBeUndefined()
        abort.abort()
        if (phase === "ripgrep") expect(signal?.aborted).toBe(true)
        expect(yield* Effect.promise(() => pending).pipe(Effect.timeout("2 seconds"))).toBe("cancelled")
        yield* Deferred.await(released)
      }),
    )
  }
}

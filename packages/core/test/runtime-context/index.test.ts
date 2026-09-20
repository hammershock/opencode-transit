import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RuntimeContext } from "@opencode-ai/core/runtime-context"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_runtime_context")
const agent = (): AgentV2.Selection => ({ id: AgentV2.ID.make("build"), info: undefined })

const part = (key: string, order: number, text?: string, enabled: (agent: AgentV2.Selection) => boolean = () => true) =>
  ({
    key,
    label: key,
    tag: `<${key}>`,
    order,
    enabled,
    render: () => Effect.succeed(text),
  }) satisfies RuntimeContext.Part

const it = testEffect(AppNodeBuilder.build(RuntimeContext.node))

describe("RuntimeContext", () => {
  it.effect("assembles empty when no parts are registered", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      expect(yield* runtime.assemble(sessionID, agent())).toEqual([])
    }),
  )

  it.effect("renders parts in stable order", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      yield* runtime.register(part("second", 20, "second"))
      yield* runtime.register(part("first", 10, "first"))

      expect((yield* runtime.assemble(sessionID, agent())).map((item) => item.text)).toEqual(["first", "second"])
    }),
  )

  it.effect("omits disabled parts and empty renders", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      yield* runtime.register(part("enabled", 10, "enabled"))
      yield* runtime.register(part("disabled", 20, "disabled", () => false))
      yield* runtime.register(part("empty", 30, undefined))

      expect((yield* runtime.assemble(sessionID, agent())).map((item) => item.key)).toEqual(["enabled"])
    }),
  )

  it.effect("keeps key, label and tag on rendered parts", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      yield* runtime.register(part("skills", 10, "guidance"))

      expect(yield* runtime.assemble(sessionID, agent())).toEqual([
        { key: "skills", label: "skills", tag: "<skills>", text: "guidance" },
      ])
    }),
  )

  it.effect("rejects duplicate part keys", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      yield* runtime.register(part("skills", 10, "first"))

      const exit = yield* runtime.register(part("skills", 20, "second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Duplicate runtime context part key")
    }),
  )

  it.effect("removes a part when its owning scope closes", () =>
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext.Service
      const scope = yield* Scope.make()
      yield* runtime.register(part("scoped", 10, "scoped")).pipe(Scope.provide(scope))

      expect((yield* runtime.assemble(sessionID, agent())).map((item) => item.key)).toEqual(["scoped"])

      yield* Scope.close(scope, Exit.void)
      expect(yield* runtime.assemble(sessionID, agent())).toEqual([])
    }),
  )
})

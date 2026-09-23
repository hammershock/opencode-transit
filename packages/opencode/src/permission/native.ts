import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { InstanceState } from "@/effect/instance-state"
import { PluginV2 } from "@opencode-ai/core/plugin"

interface Pending {
  info: PermissionV1.Request
  permission: PermissionV2.Interface
}

export const make = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const access = yield* SessionLocationAccess.Service
  // Only a compatibility reply index: Core owns the decision and pending wait.
  const state = yield* InstanceState.make(() =>
    Effect.gen(function* () {
      const pending = new Map<PermissionV1.ID, Pending>()
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...pending.values()],
          (entry) =>
            entry.permission
              .reply({ requestID: PermissionV2.ID.make(entry.info.id), reply: "reject" })
              .pipe(Effect.ignore),
          { discard: true },
        ),
      )
      return pending
    }),
  )

  const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput & { agent?: string }) {
    const pending = yield* InstanceState.get(state)
    const location = yield* access.require(input.sessionID).pipe(Effect.orDie)
    return yield* Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
      const permission = yield* PermissionV2.Service
      const id = input.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: input.sessionID,
        permission: input.permission,
        patterns: input.patterns,
        metadata: input.metadata,
        always: input.always,
        tool: input.tool,
      }
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => pending.set(id, { info, permission })),
        () =>
          permission.assert({
            id: PermissionV2.ID.make(id),
            sessionID: input.sessionID,
            action: input.permission,
            resources: input.patterns,
            save: input.always,
            metadata: input.metadata,
            agent: input.agent ? AgentV2.ID.make(input.agent) : undefined,
            source: input.tool
              ? { type: "tool", messageID: input.tool.messageID, callID: input.tool.callID }
              : undefined,
            remember: "runtime",
          }),
        () =>
          Effect.sync(() => {
            pending.delete(id)
          }),
      )
    }).pipe(
      Effect.provide(locations.get(location)),
      Effect.catchTags({
        "PermissionV2.BlockedError": (error) =>
          Effect.fail(
            new PermissionV1.DeniedError({
              ruleset: error.rules.map((rule) => ({
                permission: rule.action,
                pattern: rule.resource,
                action: rule.effect,
              })),
            }),
          ),
        "PermissionV2.CorrectedError": (error) =>
          Effect.fail(new PermissionV1.CorrectedError({ feedback: error.feedback })),
        "Session.NotFoundError": Effect.die,
        "SessionPolicy.Failure": Effect.die,
      }),
      Effect.catchDefect((cause) =>
        cause instanceof PermissionV2.DeclinedError ? Effect.fail(new PermissionV1.RejectedError()) : Effect.die(cause),
      ),
    )
  })

  const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
    const pending = yield* InstanceState.get(state)
    const entry = pending.get(input.requestID)
    if (!entry) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
    yield* entry.permission
      .reply({ requestID: PermissionV2.ID.make(input.requestID), reply: input.reply, message: input.message })
      .pipe(
        Effect.catchTag(
          "PermissionV2.NotFoundError",
          () => new PermissionV1.NotFoundError({ requestID: input.requestID }),
        ),
        Effect.catchTag("SessionPolicy.Failure", Effect.die),
      )
  })

  const list = Effect.fn("Permission.list")(function* () {
    const entries = Array.from((yield* InstanceState.get(state)).values())
    return yield* Effect.filter(entries, (entry) =>
      entry.permission.get(PermissionV2.ID.make(entry.info.id)).pipe(Effect.map(Boolean)),
    ).pipe(Effect.map((current) => current.map((entry) => entry.info)))
  })
  return { ask, reply, list }
})

export * as PermissionNative from "./native"

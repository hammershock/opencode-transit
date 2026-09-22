import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { stage, clear, commit } from "@opencode-ai/core/session/revert"
import { Effect, Layer, Context, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const state = yield* SessionRunState.Service
    const database = yield* Database.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const execution = yield* SessionExecution.Service
    const current = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      yield* execution.interrupt(input.sessionID)
      const session = yield* current(input.sessionID)
      const messages = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const index = messages.findIndex((message) => message.info.id === input.messageID)
      const target = messages[index]
      const offset = input.partID ? target?.parts.findIndex((part) => part.id === input.partID) : undefined
      if (input.partID && (offset === undefined || offset < 0))
        return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const partID =
        offset !== undefined &&
        target?.parts.slice(0, offset).some((part) => part.type === "text" || part.type === "tool")
          ? input.partID
          : undefined
      const user =
        index < 0 ? undefined : messages.slice(0, index + 1).findLast((message) => message.info.role === "user")
      const staged = yield* stage({
        session,
        messageID: SessionMessage.ID.make(partID ? input.messageID : (user?.info.id ?? input.messageID)),
        partID,
      }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
        Effect.provide(locations.get(session.location)),
        Effect.orDie,
      )
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: staged.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: staged.files.reduce((sum, file) => sum + file.deletions, 0),
          files: staged.files.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* state.assertNotBusy(input.sessionID)
      yield* execution.interrupt(input.sessionID)
      const session = yield* current(input.sessionID)
      yield* clear(session).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
        Effect.provide(locations.get(session.location)),
        Effect.orDie,
      )
      yield* sessions.touch(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      yield* commit(yield* current(session.id)).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
      )
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    EventV2Bridge.node,
    SessionRunState.node,
    Database.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionExecution.node,
  ],
})

export * as SessionRevert from "./revert"

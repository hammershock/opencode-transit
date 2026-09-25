export * as SessionPeerWait from "./peer-wait"

import { Effect, Option, Queue, Schema } from "effect"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionPeerMessage } from "./peer-message"
import { SessionSchema } from "./schema"

export class InvalidRequest extends Error {
  readonly code = "peer_wait_invalid_request"
}

export const waitReply = Effect.fn("SessionPeerWait.waitReply")(function* (input: {
  sessionID: SessionSchema.ID
  requestIDs?: readonly string[]
  timeoutMs?: number
}) {
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)
  )
    return yield* Effect.fail(new InvalidRequest())
  const events = yield* EventV2.Service
  const requestIDs =
    input.requestIDs ?? (yield* SessionPeerMessage.openRequests(input.sessionID)).map((item) => item.id)
  if (requestIDs.length < 1) return { reason: "timeout" as const, timedOut: true }
  const timeoutMs = input.timeoutMs ?? 30_000
  const started = Date.now()
  return yield* Effect.gen(function* () {
    const signals = yield* Queue.sliding<"reply" | "parent_input">(32)
    yield* Effect.acquireRelease(
      events.listen((event) => {
        if (
          !Schema.is(SessionEvent.PeerMessageSent)(event) &&
          !Schema.is(SessionEvent.PromptAdmitted)(event) &&
          !Schema.is(SessionEvent.LegacyUserInput)(event)
        )
          return Effect.void
        if (event.data.sessionID !== input.sessionID) return Effect.void
        if (Schema.is(SessionEvent.PeerMessageSent)(event))
          return event.data.kind === "reply" ? Queue.offer(signals, "reply").pipe(Effect.asVoid) : Effect.void
        if (Schema.is(SessionEvent.PromptAdmitted)(event) && (event.data.origin || event.data.task)) return Effect.void
        return Queue.offer(signals, "parent_input").pipe(Effect.asVoid)
      }),
      (unsubscribe) => unsubscribe.pipe(Effect.andThen(Queue.shutdown(signals))),
    )
    while (true) {
      const result = yield* SessionPeerMessage.takeReply({ sessionID: input.sessionID, requestIDs })
      if (result)
        return {
          reason: "reply" as const,
          timedOut: false,
          data: {
            alias: result.request.alias,
            requestID: result.request.id,
            messageID: result.reply.id,
            text: result.reply.text.slice(0, 8192),
            truncated: result.reply.text.length > 8192,
            resultRef: result.reply.id,
          },
        }
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) return { reason: "timeout" as const, timedOut: true }
      const next = yield* Queue.take(signals).pipe(Effect.timeoutOption(remaining))
      if (Option.isNone(next)) {
        const final = yield* SessionPeerMessage.takeReply({ sessionID: input.sessionID, requestIDs })
        if (final)
          return {
            reason: "reply" as const,
            timedOut: false,
            data: {
              alias: final.request.alias,
              requestID: final.request.id,
              messageID: final.reply.id,
              text: final.reply.text.slice(0, 8192),
              truncated: final.reply.text.length > 8192,
              resultRef: final.reply.id,
            },
          }
        return { reason: "timeout" as const, timedOut: true }
      }
      if (next.value === "parent_input") return { reason: "parent_input" as const, timedOut: false }
    }
  }).pipe(Effect.scoped)
})

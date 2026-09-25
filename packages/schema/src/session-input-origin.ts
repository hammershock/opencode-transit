export * as SessionInputOrigin from "./session-input-origin"

import { Schema } from "effect"
import { optional } from "./schema"
import { SessionID } from "./session-id"

export const Origin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delegation_result"),
    invocationInputID: Schema.String,
    terminalEventID: Schema.String,
    version: Schema.Literal(1),
  }),
  Schema.Struct({
    kind: Schema.Literal("peer_message"),
    sourceSessionID: SessionID,
    alias: Schema.String,
    messageKind: Schema.Literals(["request", "reply", "notice"]),
    requestID: Schema.String.pipe(optional),
    version: Schema.Literal(1),
  }),
]).annotate({ identifier: "SessionInput.Origin" })
export type Origin = typeof Origin.Type

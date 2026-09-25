import type { V2SessionTaskStatusResponses } from "@opencode-ai/sdk/v2"

type View = V2SessionTaskStatusResponses[200]["data"][number]

export function taskReceiptID(value: unknown) {
  if (typeof value !== "string") return
  return /^<task id="(ses_[A-Za-z0-9]+)"/.exec(value)?.[1]
}

export function taskInvocationMatches(view: View, parentSessionID: string, parentMessageID: string, callID: string) {
  const invocation = view.target.invocation
  return (
    invocation?.parent_session_id === parentSessionID &&
    invocation.parent_message_id === parentMessageID &&
    invocation.call_id === callID
  )
}

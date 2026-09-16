export * as TaskInvocation from "./task-invocation"

/** Correlation for one parent tool call, independent of the reusable child Session. */
export interface Info {
  parentMessageID: string
  callID?: string
  childMessageID: string
}

export function read(value: unknown): Info | undefined {
  if (!value || typeof value !== "object") return
  if (!("parentMessageID" in value) || typeof value.parentMessageID !== "string") return
  if (!("childMessageID" in value) || typeof value.childMessageID !== "string") return
  if (!value.parentMessageID || !value.childMessageID) return
  return {
    parentMessageID: value.parentMessageID,
    childMessageID: value.childMessageID,
    ...("callID" in value && typeof value.callID === "string" ? { callID: value.callID } : {}),
  }
}

/** Assistant parentage survives replay and reordered delivery; timestamps do not. */
export function includes(invocation: Info, message: { id: string; role: string; parentID?: string }) {
  return (
    message.id === invocation.childMessageID ||
    (message.role === "assistant" && message.parentID === invocation.childMessageID)
  )
}

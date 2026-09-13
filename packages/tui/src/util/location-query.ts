import type { LocationRef } from "@opencode-ai/sdk/v2"

export function locationKey(location: LocationRef) {
  return JSON.stringify([location.target, location.directory, location.workspaceID])
}

export function locationQuery(location: LocationRef | undefined) {
  if (!location) return
  return {
    directory: location.directory,
    ...(location.workspaceID ? { workspace: location.workspaceID } : {}),
    ...(location.target?.type === "rexd" ? { target: location.target.targetID } : {}),
  }
}

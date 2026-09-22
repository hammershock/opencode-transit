import type { Session } from "@opencode-ai/sdk/v2"
import type { HomeSessionTarget } from "./session-destination"

export type RecentLocation = {
  key: string
  target: HomeSessionTarget
  directory: string
  updated: number
}

export function recentLocations(
  sessions: readonly Pick<
    Session,
    "directory" | "target" | "lastKnownTargetName" | "portableTargetLabel" | "parentID" | "time"
  >[],
) {
  const rows = new Map<string, RecentLocation>()
  sessions
    .filter((session) => !session.parentID && session.time.archived === undefined)
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .forEach((session) => {
      // A portable name without a device-local binding must never become local.
      if (!session.target && session.portableTargetLabel) return
      const target: HomeSessionTarget =
        session.target?.type === "rexd"
          ? {
              ...session.target,
              name: session.lastKnownTargetName ?? session.portableTargetLabel ?? session.target.targetID,
            }
          : { type: "local" }
      const key = JSON.stringify([target.type === "local" ? null : target.targetID, session.directory])
      if (rows.has(key) || !session.directory) return
      rows.set(key, { key, target, directory: session.directory, updated: session.time.updated })
    })
  return [...rows.values()].slice(0, 20)
}

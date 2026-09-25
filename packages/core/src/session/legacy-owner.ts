export * as SessionLegacyOwner from "./legacy-owner"

import { Effect } from "effect"
import { SessionSchema } from "./schema"

type Owner = {
  readonly generation: () => string | undefined
  readonly interruptGeneration: (generation: string) => Effect.Effect<"interrupted" | "completed" | "stale">
}

const active = new Map<SessionSchema.ID, Owner>()

/** Legacy runner registrations are process-local; they do not imply remote ownership. */
export function register(sessionID: SessionSchema.ID, owner: Owner) {
  const previous = active.get(sessionID)
  if (previous && previous !== owner) throw new Error(`Legacy Session already has an owner: ${sessionID}`)
  active.set(sessionID, owner)
  return () => {
    if (active.get(sessionID) === owner) active.delete(sessionID)
  }
}

export function generation(sessionID: SessionSchema.ID) {
  return active.get(sessionID)?.generation()
}

export function interruptGeneration(sessionID: SessionSchema.ID, expected: string) {
  return active.get(sessionID)?.interruptGeneration(expected) ?? Effect.succeed("stale" as const)
}

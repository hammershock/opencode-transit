export * as SessionIdleCache from "./idle-cache"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export interface Resource {
  /** Release only rebuildable in-memory state. This must not mutate a Session. */
  readonly evict: (sessionID: SessionSchema.ID) => void
}

export interface Interface {
  readonly retain: (sessionID: SessionSchema.ID, resource: Resource) => void
  readonly forget: (sessionID: SessionSchema.ID, resource: Resource) => void
  readonly active: (sessionID: SessionSchema.ID) => void
  readonly idle: (sessionID: SessionSchema.ID) => void
  readonly snapshot: () => { readonly idle: readonly SessionSchema.ID[]; readonly active: readonly SessionSchema.ID[] }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionIdleCache") {}

export const Capacity = 128

export const make = (capacity = Capacity): Interface => {
  const entries = new Map<SessionSchema.ID, WeakRef<Resource>[]>()
  const running = new Set<SessionSchema.ID>()

  const trim = () => {
    for (const [sessionID, resources] of entries) if (!resources.some((ref) => ref.deref())) entries.delete(sessionID)
    while ([...entries.keys()].filter((id) => !running.has(id)).length > capacity) {
      const oldest = [...entries.keys()].find((id) => !running.has(id))
      if (!oldest) return
      const resources = entries.get(oldest) ?? []
      entries.delete(oldest)
      for (const ref of resources) ref.deref()?.evict(oldest)
    }
  }

  return Service.of({
    retain: (sessionID, resource) => {
      const resources = entries.get(sessionID) ?? []
      if (!resources.some((ref) => ref.deref() === resource)) resources.push(new WeakRef(resource))
      if (!entries.has(sessionID)) entries.set(sessionID, resources)
      trim()
    },
    forget: (sessionID, resource) => {
      const resources = entries.get(sessionID)?.filter((ref) => {
        const current = ref.deref()
        return current && current !== resource
      })
      if (!resources) return
      if (resources.length === 0) entries.delete(sessionID)
      else entries.set(sessionID, resources)
    },
    active: (sessionID) => {
      running.add(sessionID)
      const resources = entries.get(sessionID)
      if (resources) {
        entries.delete(sessionID)
        entries.set(sessionID, resources)
      }
    },
    idle: (sessionID) => {
      running.delete(sessionID)
      const resources = entries.get(sessionID)
      if (resources) {
        entries.delete(sessionID)
        entries.set(sessionID, resources)
      }
      trim()
    },
    snapshot: () => ({
      idle: [...entries.keys()].filter((id) => !running.has(id)),
      active: [...running],
    }),
  })
}

export const node = makeGlobalNode({ service: Service, layer: Layer.sync(Service, () => make()), deps: [] })

import { describe, expect } from "bun:test"
import path from "path"
import os from "node:os"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer } from "effect"
import { AgentPermission } from "../../src/agent/agent-permission"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(CrossSpawnSpawner.node),
    locationServiceMapLayer,
    testInstanceStoreLayer,
  ),
)

describe("AgentPermission.resolve", () => {
  it.live("degrades to an empty whitelist for an unavailable location", () =>
    Effect.gen(function* () {
      const missing = path.join(os.tmpdir(), `opencode-missing-${process.pid}-${Date.now()}`)
      const locations = yield* LocationServiceMap.Service
      const whitelist = yield* AgentPermission.resolve(locations, {
        location: Location.Ref.make({ directory: AbsolutePath.make(missing) }),
        withReferences: false,
      })
      expect(whitelist).toEqual([])
    }),
  )

  it.live("resolves skill directories for a local location", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "review", "SKILL.md"),
          "---\nname: review\ndescription: review\n---\n\n# Review\n",
        ),
      )
      const locations = yield* LocationServiceMap.Service
      const whitelist = yield* AgentPermission.resolve(locations, {
        location: Location.Ref.make({ directory: AbsolutePath.make(dir) }),
        withReferences: false,
      })
      expect(whitelist).toContain(path.join(dir, ".opencode", "skill", "review", "*"))
    }),
  )
})

describe("AgentPermission.resolveSessionPermission", () => {
  it.live("appends the location whitelist as external_directory allow rules", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "review", "SKILL.md"),
          "---\nname: review\ndescription: review\n---\n\n# Review\n",
        ),
      )
      const locations = yield* LocationServiceMap.Service
      const permission = yield* AgentPermission.resolveSessionPermission(locations, {
        directory: dir,
        withReferences: false,
      })
      expect(permission).toContainEqual({
        permission: "external_directory",
        pattern: path.join(dir, ".opencode", "skill", "review", "*"),
        action: "allow",
      })
    }),
  )

  it.live("preserves existing permission and appends the whitelist after it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const existing = { permission: "edit" as const, pattern: "*" as const, action: "deny" as const }
      const permission = yield* AgentPermission.resolveSessionPermission(locations, {
        permission: [existing],
        directory: dir,
        withReferences: false,
      })
      expect(permission).toContainEqual(existing)
      expect(permission[0]).toEqual(existing)
    }),
  )
})

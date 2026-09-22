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

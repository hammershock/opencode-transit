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
import { Permission } from "../../src/permission"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), locationServiceMapLayer, testInstanceStoreLayer),
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
  it.live("allows discovered skill paths when no session override is supplied", () =>
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
      expect(
        Permission.evaluate(
          "external_directory",
          path.join(dir, ".opencode", "skill", "review", "script.ts"),
          permission,
        ).action,
      ).toBe("allow")
    }),
  )

  for (const action of ["deny", "ask"] as const) {
    it.live(`preserves explicit ${action} rules over discovered skill defaults`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const file = path.join(dir, ".opencode", "skill", "review", "SKILL.md")
        yield* Effect.promise(() => Bun.write(file, "---\nname: review\ndescription: review\n---\n\n# Review\n"))
        const locations = yield* LocationServiceMap.Service
        yield* Effect.forEach(["*", file], (pattern) =>
          Effect.gen(function* () {
            const permission = yield* AgentPermission.resolveSessionPermission(locations, {
              directory: dir,
              withReferences: false,
              permission: [{ permission: "external_directory", pattern, action }],
            })
            expect(Permission.evaluate("external_directory", file, permission).action).toBe(action)
          }),
        )
      }),
    )
  }

  it.live("preserves explicit rule order and does not mutate caller rules", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, ".opencode", "skill", "review", "SKILL.md")
      yield* Effect.promise(() => Bun.write(file, "---\nname: review\ndescription: review\n---\n\n# Review\n"))
      const locations = yield* LocationServiceMap.Service
      const existing = [
        { permission: "edit", pattern: "*", action: "deny" as const },
        { permission: "external_directory", pattern: "*", action: "deny" as const },
        { permission: "external_directory", pattern: file, action: "allow" as const },
      ]
      const before = structuredClone(existing)
      const permission = yield* AgentPermission.resolveSessionPermission(locations, {
        permission: existing,
        directory: dir,
        withReferences: false,
      })
      expect(existing).toEqual(before)
      expect(Permission.evaluate("external_directory", file, permission).action).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(path.dirname(file), "script.ts"), permission).action,
      ).toBe("deny")
      expect(Permission.evaluate("edit", file, permission).action).toBe("deny")
    }),
  )
})

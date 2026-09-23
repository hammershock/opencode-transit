import { afterAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import { mkdtempSync } from "node:fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionLocationRuntime } from "@opencode-ai/core/session/location-runtime"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { testEffect } from "./lib/effect"

const registryDir = mkdtempSync(path.join(os.tmpdir(), "opencode-core-activation-targets-"))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const targetRegistry = Layer.succeed(
  TargetRegistry.Service,
  TargetRegistry.Service.of(TargetRegistry.make({ directory: registryDir })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionLocationRuntime.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [TargetRegistry.node, targetRegistry],
    ],
  ),
)

afterAll(() => fs.rm(registryDir, { recursive: true, force: true }))

const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

const writeRegistry = (description: string) =>
  fs.writeFile(
    path.join(registryDir, "targets.jsonc"),
    `{\n  "version": 1,\n  "targets": {\n    "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9": {\n      "name": "gpu",\n      "description": ${JSON.stringify(description)},\n      "transport": "ssh",\n      "connection": { "type": "ssh-config", "host": "gpu" },\n      "workspaceRoots": ["/"]\n    }\n  }\n}\n`,
  )

const targetsText = (runtimeParts: readonly { key: string; text: string }[]) =>
  runtimeParts.find((part) => part.key === "targets")?.text

describe("SessionV2.activate refreshes the available-targets runtime context", () => {
  it.effect("re-reads the target registry after activation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRegistry("before"))
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.activate(created.id)
      const first = yield* session.requestContext(created.id)
      expect(targetsText(first.runtimeParts)).toContain("<description>before</description>")

      yield* Effect.promise(() => writeRegistry("after"))

      // The session cache keeps the stale description until the next activation.
      const cached = yield* session.requestContext(created.id)
      expect(targetsText(cached.runtimeParts)).toContain("<description>before</description>")

      yield* session.activate(created.id)
      const refreshed = yield* session.requestContext(created.id)
      expect(targetsText(refreshed.runtimeParts)).toContain("<description>after</description>")
    }),
  )
})

import { afterAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import { mkdtempSync } from "node:fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Reference } from "@opencode-ai/core/reference"
import { RuntimeContext } from "@opencode-ai/core/runtime-context"
import { RuntimeContextBuiltIns } from "@opencode-ai/core/runtime-context/builtins"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(process.cwd())
const registryDir = mkdtempSync(path.join(os.tmpdir(), "opencode-core-available-targets-"))
const agent = (): AgentV2.Selection => ({ id: AgentV2.ID.make("build"), info: undefined })

const instructionContext = Layer.mock(InstructionContext.Service, {
  extend: () => Effect.void,
  list: () => Effect.succeed(ModelContext.Instructions.make([])),
})
const reference = Layer.mock(Reference.Service, { list: () => Effect.succeed([]) })
const targetRegistryLayer = Layer.succeed(
  TargetRegistry.Service,
  TargetRegistry.Service.of(TargetRegistry.make({ directory: registryDir })),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, RuntimeContext.node, RuntimeContextBuiltIns.node]),
    [
      [Location.node, Location.boundNode({ directory })],
      [TargetRegistry.node, targetRegistryLayer],
      [InstructionContext.node, instructionContext],
      [Reference.node, reference],
    ],
  ),
)

afterAll(() => fs.rm(registryDir, { recursive: true, force: true }))

const targetsPart = (rendered: readonly RuntimeContext.Rendered[]) =>
  rendered.find((part) => part.key === "available-targets")

function sessionRow(id: string, parentID?: string) {
  return {
    id: SessionSchema.ID.make(id),
    project_id: Project.ID.global,
    parent_id: parentID ? SessionSchema.ID.make(parentID) : null,
    slug: "test",
    directory,
    title: "test",
    version: "test",
  }
}

const writeRegistry = (text: string) => fs.writeFile(path.join(registryDir, "targets.jsonc"), text)

const validRegistry = (description: string) =>
  `{\n  "version": 1,\n  "targets": {\n    "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9": {\n      "name": "gpu",\n      "description": ${JSON.stringify(description)},\n      "transport": "ssh",\n      "connection": { "type": "ssh-config", "host": "gpu" },\n      "workspaceRoots": ["/"]\n    }\n  }\n}\n`

describe("runtime-context available targets assembly", () => {
  it.effect("renders the available-targets part with primary guidance", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRegistry(validRegistry("first")))

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(SessionTable).values(sessionRow("ses_primary")).onConflictDoNothing().run().pipe(Effect.orDie)

      const runtime = yield* RuntimeContext.Service
      const rendered = yield* runtime.assemble(SessionSchema.ID.make("ses_primary"), agent())
      const part = targetsPart(rendered)

      expect(part).toBeDefined()
      expect(part?.tag).toBe("<available-targets>")
      expect(part?.text).toContain('slash_command({ command: "/target list" })')
      expect(part?.text).toContain("<name>gpu</name>")
      expect(part?.text).toContain("<description>first</description>")
    }),
  )

  it.effect("uses child guidance for a session with a parent", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRegistry(validRegistry("first")))

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(sessionRow("ses_child", "ses_parent"))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const runtime = yield* RuntimeContext.Service
      const rendered = yield* runtime.assemble(SessionSchema.ID.make("ses_child"), agent())
      const part = targetsPart(rendered)

      expect(part).toBeDefined()
      expect(part?.text).not.toContain("slash_command(")
      expect(part?.text).toContain("subagent")
    }),
  )

  it.effect("refreshes the catalog after explicit invalidation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRegistry(validRegistry("before")))

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(sessionRow("ses_refresh"))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const runtime = yield* RuntimeContext.Service
      const sessionID = SessionSchema.ID.make("ses_refresh")

      expect(targetsPart(yield* runtime.assemble(sessionID, agent()))?.text).toContain("<description>before</description>")

      yield* Effect.promise(() => writeRegistry(validRegistry("after")))
      yield* runtime.invalidate(sessionID)

      expect(targetsPart(yield* runtime.assemble(sessionID, agent()))?.text).toContain("<description>after</description>")
    }),
  )

  it.effect("surfaces an invalid registry instead of an empty list", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRegistry('{\n  "version": 1,\n  "targets": "not-an-object"\n}\n'))

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(sessionRow("ses_invalid"))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const runtime = yield* RuntimeContext.Service
      const part = targetsPart(yield* runtime.assemble(SessionSchema.ID.make("ses_invalid"), agent()))

      expect(part?.text).toContain("<invalid-registry>")
      expect(part?.text).not.toContain("<selector>local</selector>")
    }),
  )
})

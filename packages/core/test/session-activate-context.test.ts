import { afterAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import { mkdtempSync } from "node:fs"
import os from "os"
import path from "path"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/core/session/event"
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
  runtimeParts.find((part) => part.key === "available-targets")?.text

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

describe("SessionV2.requestContext compaction inspection", () => {
  it.effect("shows completed legacy summaries and prefers the newest checkpoint", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const { db } = yield* Database.Service

      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('legacy_user', ${created.id}, 1, 1, '{"role":"user"}')`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('legacy_marker', 'legacy_user', ${created.id}, 1, 1, '{"type":"compaction","auto":true}')`)
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('legacy_failed', ${created.id}, 2, 2, '{"role":"assistant","parentID":"legacy_user","summary":true,"error":{"name":"failed"}}')`)
      expect((yield* session.requestContext(created.id)).compaction).toBeNull()

      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('legacy_summary', ${created.id}, 3, 3, '{"role":"assistant","parentID":"legacy_user","summary":true,"finish":"stop"}')`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('legacy_text', 'legacy_summary', ${created.id}, 3, 3, '{"type":"text","text":"Earlier work summary"}')`)
      expect((yield* session.requestContext(created.id)).compaction).toEqual({
        source: "legacy",
        reason: "auto",
        summary: "Earlier work summary",
        recent: "",
      })

      const events = yield* EventV2.Service
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID: created.id,
        messageID,
        timestamp: DateTime.makeUnsafe(4),
        reason: "manual",
        text: "New checkpoint",
        recent: "Recent turns",
      })
      expect((yield* session.requestContext(created.id)).compaction).toEqual({
        reason: "manual",
        summary: "New checkpoint",
        recent: "Recent turns",
      })

      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('legacy_newer', ${created.id}, 5, 5, '{"role":"assistant","parentID":"legacy_user","summary":true,"finish":"stop"}')`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('legacy_newer_text', 'legacy_newer', ${created.id}, 5, 5, '{"type":"text","text":"Latest legacy summary"}')`)
      expect((yield* session.requestContext(created.id)).compaction).toEqual({
        source: "legacy",
        reason: "auto",
        summary: "Latest legacy summary",
        recent: "",
      })
    }),
  )
})

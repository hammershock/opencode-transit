import { afterEach, describe, expect } from "bun:test"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const snapshot: TargetRegistry.Snapshot = {
  path: "fixture",
  revision: "fixture",
  valid: true,
  diagnostics: [],
  targets: [
    {
      id: Location.TargetID.make("00000000-0000-4000-8000-000000000001"),
      status: "unverified",
      name: "gpu-test",
      description: "Test compute target",
      transport: "ssh",
      connection: { type: "ssh-config", host: "fixture-host" },
      workspaceRoots: [],
    },
  ],
}

const layer = LayerNode.compile(
  LayerNode.group([ToolRegistry.node, Agent.node, Session.node, Database.node, EventV2.node, SessionProjector.node]),
  [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((directory) => [path.join(directory, ".opencode")])),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [LocationServiceMap.node, locationServiceMapLayer],
    [
      TargetRegistry.node,
      Layer.succeed(TargetRegistry.Service, {
        ...TargetRegistry.make({ directory: path.join(tmpdir(), "opencode-slash-command-unused") }),
        load: async () => snapshot,
      }),
    ],
  ],
)
const it = testEffect(layer)
const withEnvironment = testEffect(
  layer.pipe(
    Layer.provideMerge(
      Layer.mock(LocationEnvironment.Service, {
        reload: () => Effect.succeed({ enabled: true, generation: 7, values: {}, variables: [], sources: [] }),
      }),
    ),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("Agent slash commands", () => {
  it.instance("lists targets without Location Environment and keeps the subagent guard", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({})
      const child = yield* session.create({ parentID: parent.id })
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "slash_command")
      expect(tool).toBeDefined()
      const context = {
        sessionID: parent.id,
        messageID: MessageID.make("msg_slash_parent"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const listed = yield* tool!.execute({ command: "/target list" }, context)
      expect(listed.metadata.status).toBe("completed")
      expect(listed.output).toContain("local")
      expect(listed.output).toContain("gpu-test")
      expect(listed.output).toContain("Test compute target")
      expect(listed.output).not.toContain("fixture-host")

      const reload = yield* tool!.execute({ command: "/env reload" }, context)
      expect(reload.metadata.code).toBe("headless_unavailable")
      expect(reload.output).toBe("Environment service is unavailable for this session")

      const unknown = yield* tool!.execute({ command: "/not-a-command" }, context)
      expect(unknown.metadata.code).toBe("unknown_command")

      const denied = yield* tool!.execute({ command: "/target list" }, { ...context, sessionID: child.id })
      expect(denied.metadata.code).toBe("subagent_forbidden")
      const agent = yield* (yield* Agent.Service).get("build")
      const visible = yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent,
        sessionID: child.id,
      })
      expect(visible.map((item) => item.id)).not.toContain("slash_command")
    }),
  )

  withEnvironment.instance("reloads when Location Environment is available", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({})
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "slash_command")
      expect(tool).toBeDefined()
      const result = yield* tool!.execute(
        { command: "/env reload" },
        {
          sessionID: parent.id,
          messageID: MessageID.make("msg_slash_reload"),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.metadata.status).toBe("completed")
      expect(result.output).toBe("Environment generation 7 loaded")
    }),
  )
})

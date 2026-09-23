import {
  bootstrapSubagentData,
  bootstrapSubagentCalls,
  createSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"
import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPolicyAccess } from "@opencode-ai/core/session/policy-access"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Subagent } from "@/agent/subagent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  LocationServiceMap,
  buildLocationServiceMap,
  localProvider,
  locationServiceMapLayer,
} from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { ExecutionPolicy } from "@opencode-ai/core/permission/policy"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}, replacements: LayerNode.Replacements = []) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Subagent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionPolicyAccess.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [LocationServiceMap.node, locationServiceMapLayer],
      ...replacements,
    ],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
const remoteTarget = Location.RexdTarget.make({
  type: "rexd",
  targetID: Location.TargetID.make("00000000-0000-4000-8000-000000000122"),
})
const remoteLocation = Location.Ref.make({ target: remoteTarget, directory: AbsolutePath.make("/home/agent/project") })
const remote = testEffect(
  layer({}, [
    [
      LocationServiceMap.node,
      buildLocationServiceMap(
        [],
        [
          localProvider,
          {
            target: "rexd",
            build: (ref, replacements) =>
              localProvider.build(
                Location.Ref.make({ ...ref, directory: AbsolutePath.make(process.cwd()) }),
                replacements.concat([
                  [
                    ExecutionPolicy.node,
                    Layer.succeed(
                      ExecutionPolicy.Service,
                      ExecutionPolicy.Service.of({
                        resolve: () =>
                          Effect.succeed({
                            agentRules: [],
                            rules: [],
                            ceilings: [],
                            session: {
                              status: "current",
                              revision: 0,
                              legacyDigest: "0".repeat(64),
                              location: remoteLocation,
                              locationRevision: 0,
                              baseline: [],
                              rules: [],
                            },
                          }),
                      }),
                    ),
                  ],
                ]),
              ),
          },
        ],
      ),
    ],
    [
      SessionPolicyAccess.node,
      Layer.mock(SessionPolicyAccess.Service, {
        inspect: () =>
          Effect.succeed({
            status: "current" as const,
            revision: 0,
            legacyDigest: "0".repeat(64),
            location: remoteLocation,
            locationRevision: 0,
            baseline: [],
            rules: [],
          }),
      }),
    ],
    [
      SessionLocationAccess.node,
      Layer.succeed(
        SessionLocationAccess.Service,
        SessionLocationAccess.Service.of({
          resolve: () => Effect.succeed({ status: "resolved", location: remoteLocation }),
          require: () => Effect.succeed(remoteLocation),
        }),
      ),
    ],
  ]),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

describe("tool.task", () => {
  remote.instance("creates a subagent session at the parent session location", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const { chat, assistant } = yield* seed()
      yield* db
        .update(SessionTable)
        .set({ directory: "/home/agent/project", target: remoteTarget, last_known_target_name: "a100-2gpu" })
        .where(eq(SessionTable.id, chat.id))
        .run()
        .pipe(Effect.orDie)
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "inspect remote bug",
          prompt: "inspect the remote workspace",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect((yield* sessions.children(chat.id))[0]).toMatchObject({
        directory: "/home/agent/project",
        target: remoteTarget,
        lastKnownTargetName: "a100-2gpu",
      })
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf('<subagent id="alpha"')
        const explore = first.indexOf('<subagent id="explore"')
        const general = first.indexOf('<subagent id="general"')
        const zebra = first.indexOf('<subagent id="zebra"')

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain('<subagent id="alpha"')
        expect(description).not.toContain('<subagent id="zebra"')
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("does not publish the Task tool when the effective catalog is empty", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const subagents = yield* Subagent.Service
      const { chat } = yield* seed()
      const build = yield* agents.get("build")
      const initial = yield* subagents.resolve({
        parentAgentID: "build",
        sessionID: chat.id,
        includeInactive: true,
      })
      yield* Effect.forEach(
        initial.entries,
        (entry) =>
          Effect.gen(function* () {
            const current = yield* subagents.resolve({
              parentAgentID: "build",
              sessionID: chat.id,
              includeInactive: true,
            })
            yield* subagents.setSessionAccess({
              sessionID: chat.id,
              parentAgentID: "build",
              subagentID: entry.id,
              active: false,
              expectedRevision: current.revision,
            })
          }),
        { concurrency: 1 },
      )

      expect(
        (yield* registry.tools({ ...ref, agent: build, sessionID: chat.id })).some((tool) => tool.id === TaskTool.id),
      ).toBe(false)
    }),
  )

  it.instance("rejects a Task call when its published catalog revision is stale", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const subagents = yield* Subagent.Service
      const registry = yield* ToolRegistry.Service
      const { chat, assistant } = yield* seed()
      const build = yield* agents.get("build")
      const snapshot = yield* subagents.resolve({
        parentAgentID: "build",
        sessionID: chat.id,
        includeInactive: true,
      })
      const task = (yield* registry.tools({ ...ref, agent: build, sessionID: chat.id })).find(
        (tool) => tool.id === TaskTool.id,
      )
      if (!task) throw new Error("Task tool unavailable")

      yield* subagents.setSessionAccess({
        sessionID: chat.id,
        parentAgentID: "build",
        subagentID: "general",
        active: false,
        expectedRevision: snapshot.revision,
      })
      const exit = yield* task
        .execute(
          {
            description: "inspect stale catalog",
            prompt: "do not start after the catalog changes",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected stale catalog failure")
      expect(Cause.squash(exit.cause)).toHaveProperty("message", expect.stringContaining("catalog_changed"))
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "global access replaces the default and clears the current Session override",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const subagents = yield* Subagent.Service
        const { chat } = yield* seed()
        const initial = yield* subagents.resolve({
          parentAgentID: "build",
          sessionID: chat.id,
          includeInactive: true,
        })
        const session = yield* subagents.setSessionAccess({
          sessionID: chat.id,
          parentAgentID: "build",
          subagentID: "access-fixture",
          active: false,
          expectedRevision: initial.revision,
        })
        expect(session.entries.find((entry) => entry.id === "access-fixture")).toMatchObject({
          effective: "inactive",
          reason: "session",
        })
        expect(
          (yield* subagents.resolve({
            parentAgentID: "build",
            sessionID: chat.id,
            includeInactive: false,
          })).revision,
        ).toBe(session.revision)

        const global = yield* subagents.setGlobalAccess({
          sessionID: chat.id,
          parentAgentID: "build",
          subagentID: "access-fixture",
          active: true,
          expectedRevision: session.revision,
        })

        expect(global.entries.find((entry) => entry.id === "access-fixture")).toMatchObject({
          effective: "active",
          reason: "global",
        })
        expect((yield* sessions.get(chat.id)).subagentAccess?.build?.["access-fixture"]).toBeUndefined()
      }),
    { config: { agent: { "access-fixture": { mode: "subagent" } } } },
  )

  it.instance(
    "recovers an interrupted global access mutation before resolving the catalog",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const subagents = yield* Subagent.Service
        const { chat } = yield* seed()
        const initial = yield* subagents.resolve({
          parentAgentID: "build",
          sessionID: chat.id,
          includeInactive: true,
        })
        yield* subagents.setSessionAccess({
          sessionID: chat.id,
          parentAgentID: "build",
          subagentID: "recovery-fixture",
          active: false,
          expectedRevision: initial.revision,
        })
        const journal = path.join(Global.Path.state, "subagent-access-journal.json")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(journal), { recursive: true })
          await Bun.write(
            journal,
            JSON.stringify({
              version: 1,
              sessionID: chat.id,
              parentAgentID: "build",
              subagentID: "recovery-fixture",
              active: true,
            }),
          )
        })

        const recovered = yield* subagents.resolve({
          parentAgentID: "build",
          sessionID: chat.id,
          includeInactive: true,
        })

        expect(recovered.entries.find((entry) => entry.id === "recovery-fixture")).toMatchObject({
          effective: "active",
          reason: "global",
        })
        expect((yield* sessions.get(chat.id)).subagentAccess?.build?.["recovery-fixture"]).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(journal).exists())).toBe(false)
      }),
    { config: { agent: { "recovery-fixture": { mode: "subagent" } } } },
  )

  it.instance("serializes catalog mutations so one concurrent stale revision is rejected", () =>
    Effect.gen(function* () {
      const subagents = yield* Subagent.Service
      const { chat } = yield* seed()
      const initial = yield* subagents.resolve({
        parentAgentID: "build",
        sessionID: chat.id,
        includeInactive: true,
      })
      const outcomes = yield* Effect.all(
        ["general", "explore"].map((subagentID) =>
          subagents
            .setSessionAccess({
              sessionID: chat.id,
              parentAgentID: "build",
              subagentID,
              active: false,
              expectedRevision: initial.revision,
            })
            .pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )

      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
      const failure = outcomes.find(Exit.isFailure)
      expect(failure).toBeDefined()
      if (failure && Exit.isFailure(failure)) expect(Cause.squash(failure.cause)).toBeInstanceOf(Subagent.ConflictError)
    }),
  )

  it.instance("materializes a stable manager definition when editing existing global Markdown", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const subagents = yield* Subagent.Service
      const { chat } = yield* seed()
      const directory = path.join(Global.Path.config, "agents")
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "legacy-review.md"),
          "---\nmode: subagent\ndescription: Legacy definition\n---\nReview legacy changes.",
        ),
      )
      yield* config.invalidate()
      yield* agents.invalidate()
      const initial = yield* subagents.resolve({
        parentAgentID: "build",
        sessionID: chat.id,
        includeInactive: true,
      })
      expect(initial.entries.find((entry) => entry.id === "legacy-review")).toMatchObject({
        name: "legacy-review",
        source: "global",
        editable: true,
      })

      const updated = yield* subagents.update({
        sessionID: chat.id,
        parentAgentID: "build",
        subagentID: "legacy-review",
        expectedRevision: initial.revision,
        definition: {
          name: "Focused Legacy Reviewer",
          description: "Updated through the manager",
          prompt: "Review the focused change.",
        },
      })

      expect(updated.entries.find((entry) => entry.id === "legacy-review")).toMatchObject({
        name: "Focused Legacy Reviewer",
        description: "Updated through the manager",
      })
      const manager = (yield* Effect.promise(() => fs.readdir(directory))).find((file) =>
        file.startsWith(".subagent-legacy-review-"),
      )
      expect(manager).toBeDefined()
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, manager!)).text())).toContain(
        "schema_revision: 1",
      )
    }),
  )

  it.instance("keeps a stable ID while editing and deleting a global definition", () =>
    Effect.gen(function* () {
      const subagents = yield* Subagent.Service
      const { chat } = yield* seed()
      const initial = yield* subagents.resolve({
        parentAgentID: "build",
        sessionID: chat.id,
        includeInactive: true,
      })
      const created = yield* subagents.create({
        sessionID: chat.id,
        parentAgentID: "build",
        expectedRevision: initial.revision,
        definition: { name: "Review Agent", description: "Review focused changes" },
      })
      const added = created.entries.find((entry) => entry.name === "Review Agent")
      if (!added) throw new Error("created subagent missing")
      const definition = (yield* Effect.promise(() => fs.readdir(path.join(Global.Path.config, "agents")))).find(
        (file) => file.includes(added.id),
      )
      expect(definition).toBeDefined()

      const updated = yield* subagents.update({
        sessionID: chat.id,
        parentAgentID: "build",
        subagentID: added.id,
        expectedRevision: created.revision,
        definition: { name: "Focused Reviewer", description: "Review focused changes" },
      })
      expect(updated.entries.find((entry) => entry.id === added.id)?.name).toBe("Focused Reviewer")
      expect(
        yield* Effect.promise(() => Bun.file(path.join(Global.Path.config, "agents", definition!)).text()),
      ).toContain("name: Focused Reviewer")

      const removed = yield* subagents.remove({
        sessionID: chat.id,
        parentAgentID: "build",
        subagentID: added.id,
        expectedRevision: updated.revision,
      })
      expect(removed.entries.some((entry) => entry.id === added.id)).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(Global.Path.config, "agents", definition!)).exists())).toBe(
        false,
      )
      expect(
        (yield* Effect.promise(() => fs.readdir(path.join(Global.Path.config, ".trash", "subagents")))).some((file) =>
          file.endsWith(definition!),
        ),
      ).toBe(true)
      const recreated = yield* subagents.create({
        sessionID: chat.id,
        parentAgentID: "build",
        expectedRevision: removed.revision,
        definition: { name: "Review Agent", description: "A new definition" },
      })
      expect(recreated.entries.find((entry) => entry.name === "Review Agent")?.id).not.toBe(added.id)
    }),
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("resumed Task metadata reconstructs separate invocation progress and stable child title", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Stable child title" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const parents: SessionV1.WithParts["parts"][] = []
      const children: SessionV1.WithParts[] = []
      const boundaries: string[] = []
      for (const description of ["first investigation", "second investigation"]) {
        const callID = description
        const partID = PartID.ascending()
        const recorded: Record<string, unknown>[] = []
        const result = yield* def.execute(
          {
            description,
            prompt: description,
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            ask: () => Effect.void,
            metadata: (value) =>
              Effect.sync(() => {
                recorded.push(value.metadata ?? {})
              }),
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input: SessionPrompt.PromptInput) =>
                  Effect.sync(() => {
                    expect(recorded[0]?.invocation).toMatchObject({ childMessageID: input.messageID, callID })
                    boundaries.push(input.messageID!)
                    const message = reply(input, description)
                    children.push(message)
                    return message
                  }),
              },
            },
          },
        )
        parents.push([
          {
            id: partID,
            type: "tool",
            sessionID: chat.id,
            messageID: assistant.id,
            callID,
            tool: "task",
            state: {
              status: "completed",
              title: result.title,
              input: { description, subagent_type: "general" },
              metadata: result.metadata,
              output: result.output,
              time: { start: 1, end: 2 },
            },
          },
        ])
      }
      expect(new Set(boundaries).size).toBe(2)
      expect((yield* sessions.get(child.id)).title).toBe("Stable child title")
      const data = createSubagentData()
      bootstrapSubagentData({
        data,
        messages: parents.map((parts) => ({ parts })),
        children: [{ id: child.id }],
        permissions: [],
        questions: [],
      })
      bootstrapSubagentCalls({ data, sessionID: child.id, messages: children, thinking: true, limits: {} })
      const state = snapshotSubagentData(data)
      expect(state.tabs).toHaveLength(2)
      for (const [index, parts] of parents.entries()) {
        const detail = state.details[parts[0]!.id]!
        expect(detail.commits.filter((commit) => commit.kind === "assistant").map((commit) => commit.text)).toEqual([
          index === 0 ? "first investigation" : "second investigation",
        ])
        expect(
          detail.history?.some(
            (commit) => commit.text === (index === 0 ? "second investigation" : "first investigation"),
          ),
        ).toBe(true)
      }
    }),
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
    }),
  )

  it.instance(
    "execute asks when catalog access requires approval and skips checks when bypassed",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        const promptOps = stubOps()

        const exec = (extra?: Record<string, any>) =>
          def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps, ...extra },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                }),
            },
          )

        yield* exec()
        yield* exec({ bypassAgentCheck: true })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          permission: "task",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
          },
        })
      }),
    {
      config: {
        permission: { task: "ask" },
      },
    },
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        yield* sessions.setApprovalMode({ sessionID: chat.id, approvalMode: "auto" })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.approvalMode).toBe("auto")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  background.instance(
    "explicit config off overrides the enabled environment for execution and schema",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        expect(def.description).not.toContain("Background mode:")
        expect(def.jsonSchema?.properties).not.toHaveProperty("background")

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              background: true,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { experimental: { background_subagents: false } } },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  it.instance(
    "config enables background execution without an environment flag",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        expect(def.description).toContain("Background mode:")
        expect(def.jsonSchema).toBeUndefined()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const job = yield* jobs.get(result.metadata.sessionId)
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain(`state="running"`)
        expect(job?.status).toBe("running")
      }),
    { config: { experimental: { background_subagents: true } } },
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.metadata.invocation.childMessageID).not.toBe(started.metadata.invocation.childMessageID)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).messageID).toBe(result.metadata.invocation.childMessageID)
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})

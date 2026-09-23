import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Skill } from "@opencode-ai/schema/skill"
import { eq, sql } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const remoteProjectID = Project.ID.make("remote-project")
const remoteDirectory = AbsolutePath.make("/remote/project")
const remote = Layer.succeed(
  Location.Service,
  Location.Service.of({
    ...location({
      target: { type: "rexd", targetID: Location.TargetID.make("00000000-0000-4000-8000-000000000001") },
      directory: remoteDirectory,
    }),
    project: { id: remoteProjectID, directory: remoteDirectory },
  }),
)
const nodes = LayerNode.group([
  Location.node,
  Database.node,
  EventV2.node,
  SessionStore.node,
  PermissionSaved.node,
  AgentV2.node,
  SkillPackageAccess.node,
  PermissionV2.node,
])
const it = testEffect(AppNodeBuilder.build(nodes, [[Location.node, current]]))
const remoteRef = Location.Ref.make({
  target: { type: "rexd", targetID: Location.TargetID.make("00000000-0000-4000-8000-000000000001") },
  directory: remoteDirectory,
})
const remoteIt = testEffect(
  AppNodeBuilder.build(nodes, [
    [Location.node, remote],
    // This unit fixture supplies a resolved placement, not an SSH connection.
    [
      SessionLocationAccess.node,
      Layer.succeed(SessionLocationAccess.Service, {
        require: () => Effect.succeed(remoteRef),
        resolve: () => Effect.succeed({ status: "resolved" as const, location: remoteRef }),
      }),
    ],
  ]),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const selected = yield* Location.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: selected.directory,
        target: selected.target,
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest(input: Partial<PermissionV2.AssertInput> = {}) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request, unknown>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion(input)).pipe(
      Effect.onError((cause) => Deferred.failCause(asked, cause)),
      Effect.forkScoped,
    )
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("auto approval bypasses asks but preserves explicit denies", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ approval_mode: "auto" })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      yield* service.assert(assertion())
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.assert(assertion()).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.BlockedError)
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({
        projectID: Project.ID.global,
        projectDirectory: AbsolutePath.make("/project"),
        action: "bash",
        resources: ["pwd"],
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("scopes prepared package defaults to one Session and lets explicit ask or deny override them", () =>
    Effect.gen(function* () {
      yield* setup()
      const packages = yield* SkillPackageAccess.Service
      const root = AbsolutePath.make("/tmp/policy-package")
      const entry: SkillRegistry.Entry = {
        metadata: Skill.Metadata.make({
          id: Skill.ID.make(`skl_${"1".repeat(64)}`),
          name: "policy-package",
          description: "Policy package",
          sourceLabel: "Test",
          digest: Skill.Digest.make("2".repeat(64)),
        }),
        source: Skill.SourceDetail.make({
          kind: "imported",
          label: "Test",
          root,
          relativePath: RelativePath.make("SKILL.md"),
        }),
        sourceKey: "test:policy-package",
        location: AbsolutePath.make(`${root}/SKILL.md`),
        content: "# Policy package",
      }
      yield* packages.prepare({ entry, sessionID: SessionV2.ID.make("ses_test") })
      const service = yield* PermissionV2.Service
      const input = { action: "external_directory", resources: [`${root}/asset.txt`] }
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_package_allow"), ...input })),
      ).toMatchObject({
        effect: "allow",
      })

      yield* setRules([{ action: "external_directory", resource: `${root}/*`, effect: "ask" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_package_ask"), ...input }))).toMatchObject({
        effect: "ask",
      })
      yield* setRules([{ action: "external_directory", resource: `${root}/*`, effect: "deny" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_package_deny"), ...input }))).toMatchObject(
        {
          effect: "deny",
        },
      )

      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_other"),
          project_id: Project.ID.global,
          slug: "other",
          directory: AbsolutePath.make("/project"),
          target: { type: "local" },
          title: "other",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* setRules([])
      expect(
        yield* service.ask({
          ...assertion({ id: PermissionV2.ID.create("per_package_other"), ...input }),
          sessionID: SessionV2.ID.make("ses_other"),
        }),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("keeps captured parent boundaries as hard ceilings for child Sessions", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          parent_id: SessionV2.ID.make("ses_parent"),
          permission_boundary: [[{ action: "bash", resource: "rm *", effect: "deny" }]],
        })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["echo ok"] }))).toMatchObject({
        effect: "allow",
      })
      expect(
        yield* service.ask(
          assertion({ id: PermissionV2.ID.create("per_parent_deny"), action: "bash", resources: ["rm file"] }),
        ),
      ).toMatchObject({
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("keeps legacy always approvals in memory instead of saving them", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({
        id: PermissionV2.ID.create("per_runtime"),
        resources: ["src/runtime.ts"],
        save: ["src/*"],
        remember: "runtime",
      })
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_runtime_next"),
            resources: ["src/next.ts"],
          }),
        ),
      ).toMatchObject({ effect: "allow" })
      expect(yield* (yield* Database.Service).db.select().from(PermissionTable).all()).toEqual([])
    }),
  )

  remoteIt.effect("materializes a remote project before saving an always permission", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      const { db } = yield* Database.Service
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, remoteProjectID)).get()).toBeUndefined()

      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, remoteProjectID)).get()).toMatchObject({
        id: remoteProjectID,
        worktree: remoteDirectory,
      })
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, remoteProjectID)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
    }),
  )

  it.effect("keeps an always request pending when persistence fails", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const replied = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type ? Deferred.succeed(replied, undefined) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* db
        .run(
          sql.raw(
            "CREATE TRIGGER permission_insert_failure BEFORE INSERT ON permission BEGIN SELECT RAISE(ABORT, 'fail'); END",
          ),
        )
        .pipe(Effect.orDie)

      const exit = yield* service.reply({ requestID: request.id, reply: "always" }).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* Deferred.isDone(replied)).toBe(false)
      expect(yield* service.list()).toEqual([request])
      yield* Fiber.interrupt(fiber)
    }),
  )
})

import { describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import {
  checkResumeDenies,
  filterCrossTargetPermission,
  findParentPathDeny,
  parentDenyRules,
  planDestination,
  planResumeDestination,
  resolveTargetSelector,
  sameTarget,
  TaskPlacementError,
} from "../../src/tool/task"
import { Location } from "@opencode-ai/core/location"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { resolveLocationAgent } from "../../src/agent/location-agent"
import type { Session } from "../../src/session/session"
import type { Permission } from "@opencode-ai/schema/permission"
import type { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

const idA = Location.TargetID.make("00000000-0000-4000-8000-000000000101")
const idB = Location.TargetID.make("00000000-0000-4000-8000-000000000102")

function rexd(id: Location.TargetID): Location.Target {
  return { type: "rexd", targetID: id }
}

function definition(fields: {
  id: Location.TargetID
  name: string
  defaultDirectory?: string
  description?: string
}): TargetRegistry.Definition {
  return {
    id: fields.id,
    status: "unverified",
    name: fields.name,
    description: fields.description,
    transport: "ssh",
    connection: { type: "manual", host: "host", user: "user", port: 22 },
    defaultDirectory: fields.defaultDirectory,
    workspaceRoots: ["/"],
  }
}

function snapshot(targets: TargetRegistry.Definition[]): TargetRegistry.Snapshot {
  return { path: "/tmp/targets.jsonc", revision: "rev", targets, diagnostics: [], valid: true }
}

function session(fields: { target?: Location.Target; directory: string; lastKnownTargetName?: string }): Session.Info {
  return fields as unknown as Session.Info
}

describe("resolveTargetSelector", () => {
  const snap = snapshot([definition({ id: idA, name: "a100" }), definition({ id: idB, name: "a100" })])

  test("local selector", () => {
    expect(resolveTargetSelector("local", snap)).toEqual({ target: { type: "local" }, name: "local" })
  })

  test("exact target ID", () => {
    const resolved = resolveTargetSelector(idA, snap)
    expect(resolved.target).toEqual(rexd(idA))
    expect(resolved.name).toBe("a100")
  })

  test("unique exact display name pins to ID", () => {
    const snap2 = snapshot([definition({ id: idA, name: "a100" }), definition({ id: idB, name: "b200" })])
    const resolved = resolveTargetSelector("b200", snap2)
    expect(resolved.target).toEqual(rexd(idB))
    expect(resolved.definition?.id).toBe(idB)
  })

  test("name collision fails", () => {
    expect(() => resolveTargetSelector("a100", snap)).toThrow(TaskPlacementError)
    try {
      resolveTargetSelector("a100", snap)
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("target_name_conflict")
    }
  })

  test("unknown selector fails", () => {
    try {
      resolveTargetSelector("nope", snap)
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("unknown_target")
    }
  })
})

describe("sameTarget", () => {
  test("local matches local", () => {
    expect(sameTarget({ type: "local" }, { type: "local" })).toBe(true)
    expect(sameTarget(undefined, { type: "local" })).toBe(true)
  })
  test("local vs rexd differs", () => {
    expect(sameTarget({ type: "local" }, rexd(idA))).toBe(false)
  })
  test("same rexd ID matches", () => {
    expect(sameTarget(rexd(idA), rexd(idA))).toBe(true)
    expect(sameTarget(rexd(idA), rexd(idB))).toBe(false)
  })
})

describe("planDestination default table", () => {
  const parent = session({ directory: "/Users/parent" })
  const rexdParent = session({ target: rexd(idA), directory: "/home/agent", lastKnownTargetName: "a100" })
  const snap = snapshot([
    definition({ id: idA, name: "a100", defaultDirectory: "/home/agent/default" }),
    definition({ id: idB, name: "b200", defaultDirectory: "/home/b200/default" }),
  ])

  test("omitted target + omitted directory keeps parent", () => {
    const planned = planDestination({ targetParam: undefined, directoryParam: undefined, parent, snapshot: snap })
    expect(planned.target).toEqual({ type: "local" })
    expect(planned.directory).toBe("/Users/parent")
    expect(planned.changedPlacement).toBe(false)
    expect(planned.crossTarget).toBe(false)
  })

  test("omitted target + explicit absolute directory", () => {
    const planned = planDestination({ targetParam: undefined, directoryParam: "/Users/other", parent, snapshot: snap })
    expect(planned.target).toEqual({ type: "local" })
    expect(planned.directory).toBe("/Users/other")
    expect(planned.changedPlacement).toBe(true)
    expect(planned.crossTarget).toBe(false)
  })

  test("same target + omitted directory keeps parent directory", () => {
    const planned = planDestination({ targetParam: idA, directoryParam: undefined, parent: rexdParent, snapshot: snap })
    expect(planned.target).toEqual(rexd(idA))
    expect(planned.directory).toBe("/home/agent")
    expect(planned.changedPlacement).toBe(false)
  })

  test("different target + omitted directory uses defaultDirectory", () => {
    const planned = planDestination({
      targetParam: "b200",
      directoryParam: undefined,
      parent: rexdParent,
      snapshot: snap,
    })
    expect(planned.target).toEqual(rexd(idB))
    expect(planned.directory).toBe("/home/b200/default")
    expect(planned.crossTarget).toBe(true)
    expect(planned.changedPlacement).toBe(true)
  })

  test("different target without defaultDirectory fails", () => {
    const noDefault = snapshot([
      definition({ id: idA, name: "a100", defaultDirectory: "/home/a" }),
      definition({ id: idB, name: "b200" }),
    ])
    try {
      planDestination({ targetParam: "b200", directoryParam: undefined, parent: rexdParent, snapshot: noDefault })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("default_directory_required")
    }
  })

  test("explicit relative directory fails", () => {
    try {
      planDestination({ targetParam: undefined, directoryParam: "relative/path", parent, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("invalid_directory")
    }
  })

  test("explicit ~ directory fails", () => {
    try {
      planDestination({ targetParam: undefined, directoryParam: "~/home", parent, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("invalid_directory")
    }
  })

  test("empty directory fails", () => {
    try {
      planDestination({ targetParam: undefined, directoryParam: "", parent, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("invalid_directory")
    }
  })

  test("local target with omitted directory fails", () => {
    try {
      planDestination({ targetParam: "local", directoryParam: undefined, parent: rexdParent, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("directory_required")
    }
  })

  test("fails when the parent's remote target is missing from the registry (omitted target)", () => {
    const missingSnap = snapshot([])
    try {
      planDestination({ targetParam: undefined, directoryParam: undefined, parent: rexdParent, snapshot: missingSnap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("target_removed")
    }
  })

  test("fails on an invalid registry snapshot", () => {
    const invalid: TargetRegistry.Snapshot = {
      path: "/tmp/targets.jsonc",
      revision: "rev",
      targets: [],
      diagnostics: [{ severity: "error", path: "$", message: "bad" }],
      valid: false,
    }
    try {
      planDestination({ targetParam: undefined, directoryParam: undefined, parent, snapshot: invalid })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("invalid_registry")
    }
  })
})

describe("planResumeDestination", () => {
  const parent = session({ directory: "/Users/parent" })
  const snap = snapshot([definition({ id: idA, name: "a100", defaultDirectory: "/home/a" })])

  test("omitted target/directory uses stored child location", () => {
    const existing = session({ target: rexd(idA), directory: "/home/agent", lastKnownTargetName: "a100" })
    const planned = planResumeDestination({
      targetParam: undefined,
      directoryParam: undefined,
      parent,
      existing,
      snapshot: snap,
    })
    expect(planned.target).toEqual(rexd(idA))
    expect(planned.directory).toBe("/home/agent")
  })

  test("matching explicit target and directory are accepted", () => {
    const existing = session({ target: rexd(idA), directory: "/home/agent", lastKnownTargetName: "a100" })
    const planned = planResumeDestination({
      targetParam: idA,
      directoryParam: "/home/agent",
      parent,
      existing,
      snapshot: snap,
    })
    expect(planned.directory).toBe("/home/agent")
  })

  test("mismatched target fails", () => {
    const existing = session({ target: rexd(idA), directory: "/home/agent" })
    try {
      planResumeDestination({ targetParam: "local", directoryParam: undefined, parent, existing, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("task_location_mismatch")
    }
  })

  test("mismatched directory fails", () => {
    const existing = session({ target: rexd(idA), directory: "/home/agent" })
    try {
      planResumeDestination({ targetParam: undefined, directoryParam: "/home/other", parent, existing, snapshot: snap })
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("task_location_mismatch")
    }
  })
})

describe("findParentPathDeny", () => {
  const rules: Permission.Rule[] = [
    { action: "read", resource: "/secret/**", effect: "deny" },
    { action: "edit", resource: "/etc/hosts", effect: "deny" },
    { action: "bash", resource: "*", effect: "deny" },
    { action: "read", resource: "*.env", effect: "ask" },
  ]

  test("finds path-specific deny", () => {
    expect(findParentPathDeny(rules)).toBe("read /secret/**")
  })

  test("ignores tool-wide deny and ask", () => {
    const toolWide: Permission.Rule[] = [
      { action: "bash", resource: "*", effect: "deny" },
      { action: "read", resource: "*.env", effect: "ask" },
    ]
    expect(findParentPathDeny(toolWide)).toBeUndefined()
  })
})

describe("parentDenyRules", () => {
  test("filters denies from rules and boundary", () => {
    const rules: Permission.Rule[] = [
      { action: "read", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
    ]
    const boundary: SessionPolicy.Boundary = [[{ action: "read", resource: "/x", effect: "deny" }]]
    const result = parentDenyRules({ rules, boundary })
    expect(result).toEqual([
      { action: "read", resource: "/x", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
    ])
  })
})

describe("filterCrossTargetPermission", () => {
  test("drops path-specific allow/ask but keeps denies and tool-wide rules", () => {
    const permission: PermissionV1.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/parent/path/**", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
    ]
    const boundary: SessionPolicy.Boundary = [
      [
        { action: "read", resource: "/secret/**", effect: "allow" },
        { action: "edit", resource: "/etc/hosts", effect: "ask" },
        { action: "bash", resource: "*", effect: "deny" },
        { action: "read", resource: "*.env", effect: "ask" },
      ],
    ]
    const result = filterCrossTargetPermission({ permission, boundary })
    expect(result.permission).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ])
    expect(result.boundary[0]).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
  })
})

describe("checkResumeDenies", () => {
  test("passes when stored permission already reflects current non-path denies", () => {
    const existing = session({
      directory: "/home/agent",
      target: rexd(idA),
    }) as unknown as Session.Info
    ;(existing as unknown as { permission: PermissionV1.Ruleset }).permission = [
      { permission: "bash", pattern: "*", action: "deny" },
    ]
    expect(() => checkResumeDenies(existing, [{ action: "bash", resource: "*", effect: "deny" }])).not.toThrow()
  })

  test("fails when a newly introduced non-path deny is missing from stored permission", () => {
    const existing = session({ directory: "/home/agent" }) as unknown as Session.Info
    ;(existing as unknown as { permission: PermissionV1.Ruleset }).permission = []
    try {
      checkResumeDenies(existing, [{ action: "bash", resource: "*", effect: "deny" }])
    } catch (error) {
      expect((error as TaskPlacementError).code).toBe("task_access_changed")
    }
  })

  test("ignores path-specific denies (handled by cross-target preflight)", () => {
    const existing = session({ directory: "/home/agent" }) as unknown as Session.Info
    ;(existing as unknown as { permission: PermissionV1.Ruleset }).permission = []
    expect(() =>
      checkResumeDenies(existing, [{ action: "read", resource: "/secret/**", effect: "deny" }]),
    ).not.toThrow()
  })
})

function makeAgent(system?: string): AgentV2.Info {
  return AgentV2.Info.make({
    id: AgentV2.ID.make("general"),
    request: { headers: {}, body: {} },
    mode: "subagent",
    hidden: false,
    permissions: [],
    ...(system !== undefined ? { system } : {}),
  })
}

describe("resolveLocationAgent", () => {
  const pluginService = PluginV2.Service.of({
    add: () => Effect.void,
    remove: () => Effect.void,
    wait: () => Effect.void,
  })

  function contextWith(get: () => AgentV2.Info | undefined) {
    const agentService = {
      get: () => Effect.sync(get),
      default: () => Effect.sync(get),
      resolve: () => Effect.sync(get),
      select: () => Effect.sync(() => ({ id: get()?.id ?? AgentV2.defaultID, info: get() })),
      all: () => Effect.sync(() => (get() ? [get()!] : [])),
      permissionLayers: () => Effect.sync(() => ({ defaults: [], configured: get()?.permissions ?? [] })),
      capturePermissionDefaults: () => Effect.void,
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    } satisfies AgentV2.Interface
    return Context.make(AgentV2.Service, AgentV2.Service.of(agentService)).pipe(
      Context.add(PluginV2.Service, pluginService),
    )
  }

  test("resolves the live target Agent definition each call, not a frozen copy", async () => {
    const holder: { current: AgentV2.Info | undefined } = { current: makeAgent("v1") }
    const context = contextWith(() => holder.current)
    expect((await Effect.runPromise(resolveLocationAgent("general", context)))?.prompt).toBe("v1")

    holder.current = makeAgent("v2")
    expect((await Effect.runPromise(resolveLocationAgent("general", context)))?.prompt).toBe("v2")
  })

  test("returns undefined when the exact Agent ID is absent", async () => {
    const context = contextWith(() => undefined)
    expect(await Effect.runPromise(resolveLocationAgent("general", context))).toBeUndefined()
  })
})

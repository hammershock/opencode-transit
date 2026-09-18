import { describe, expect, test } from "bun:test"
import { Subagent } from "@/agent/subagent"

describe("subagent access", () => {
  test("resolves parent, session, global, permission, and default precedence", () => {
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: true,
        session: true,
        global: true,
        permission: "allow",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "inactive", reason: "parent-disabled" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        session: false,
        global: true,
        permission: "allow",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "inactive", reason: "session" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        global: false,
        permission: "allow",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "inactive", reason: "global" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        permission: "deny",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "inactive", reason: "permission" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        sessionPermission: "deny",
        hasSessionPermissionRule: true,
        global: true,
        permission: "allow",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "inactive", reason: "permission" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        session: true,
        sessionPermission: "deny",
        hasSessionPermissionRule: true,
        global: false,
        permission: "deny",
        hasPermissionRule: true,
      }),
    ).toEqual({ effective: "active", reason: "session" })
    expect(
      Subagent.resolveEffectiveAccess({
        parentDisabled: false,
        permission: "ask",
        hasPermissionRule: false,
      }),
    ).toEqual({ effective: "active", reason: "default" })
  })

  test("summarizes effective child capabilities conservatively", () => {
    expect(
      Subagent.summarizeCapabilities([
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "websearch", pattern: "*", action: "allow" },
      ]),
    ).toEqual(["read-only", "web", "no-delegation"])
    expect(
      Subagent.summarizeCapabilities([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "task", pattern: "*", action: "deny" },
      ]),
    ).toEqual(["workspace-write", "shell-approval", "web", "no-delegation"])
  })

  test("renders only active entries within the fixed context budget", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      description: `<unsafe & long> ${"文".repeat(200)}`,
      effective: index === 0 ? ("inactive" as const) : ("active" as const),
      reason: "default" as const,
      approvalRequired: false,
      capabilities: ["read-only", "no-delegation"],
      editable: true,
      source: "global" as const,
    }))
    const output = Subagent.render({
      revision: "rev&1",
      parentAgentID: "build",
      entries,
      diagnostics: [],
    })

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192)
    expect(output).not.toContain('id="agent-0"')
    expect(output).toContain("&lt;unsafe &amp; long&gt;")
    expect(output.split("\n").every((line) => !line.includes("\r"))).toBeTrue()
    expect(
      output
        .split("\n")
        .filter((line) => line.startsWith("<subagent "))
        .every((line) => Buffer.byteLength(line) <= 240),
    ).toBeTrue()
  })
})

import { describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import {
  escapeField,
  MAX_AVAILABLE_TARGETS_BYTES,
  renderAvailableTargets,
} from "@opencode-ai/core/runtime-context/available-targets"

const target = (id: string, name: string, description?: string): TargetRegistry.Definition => ({
  id: Location.TargetID.make(id),
  status: "unverified",
  name,
  description,
  transport: "ssh",
  connection: { type: "ssh-config", host: "gpu.internal" },
  defaultDirectory: "/home/hammer/project",
  workspaceRoots: ["/home/hammer"],
})

const snapshot = (definitions: readonly TargetRegistry.Definition[]): TargetRegistry.Snapshot => ({
  path: "/config/targets.jsonc",
  revision: "rev",
  targets: definitions,
  diagnostics: [],
  valid: true,
})

describe("renderAvailableTargets", () => {
  test("lists local and registered selectors, names and descriptions", () => {
    const id = "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9"
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot([target(id, "gpu", "2x A100")]) }, false)

    expect(text).toContain("<available-targets>")
    expect(text).toContain("<selector>local</selector>")
    expect(text).toContain(`<selector>${id}</selector>`)
    expect(text).toContain("<name>gpu</name>")
    expect(text).toContain("<description>2x A100</description>")
  })

  test("tells the primary agent to use slash_command and Task", () => {
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot([]) }, false)
    expect(text).toContain('slash_command({ command: "/target list" })')
    expect(text).toContain("Task tool")
  })

  test("does not tell a child agent it can call slash_command", () => {
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot([]) }, true)
    expect(text).not.toContain("slash_command(")
    expect(text).toContain("subagent")
  })

  test("never leaks connection details, directory or health state", () => {
    const id = "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9"
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot([target(id, "gpu", "2x A100")]) }, false)

    expect(text).not.toContain("gpu.internal")
    expect(text).not.toContain("/home/hammer")
    expect(text).not.toContain("defaultDirectory")
    expect(text).not.toContain("unverified")
    expect(text).not.toContain("checkedAt")
    expect(text).not.toContain("trustedUntil")
  })

  test("sorts registered targets deterministically by id", () => {
    const first = "11111111-1111-4111-8111-111111111111"
    const second = "22222222-2222-4222-8222-222222222222"
    const text = renderAvailableTargets(
      { kind: "ok", snapshot: snapshot([target(second, "b"), target(first, "a")]) },
      false,
    )
    expect(text.indexOf(`<selector>${first}</selector>`)).toBeLessThan(text.indexOf(`<selector>${second}</selector>`))
  })

  test("escapes XML, control characters and newlines in user text", () => {
    const id = "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9"
    const text = renderAvailableTargets(
      { kind: "ok", snapshot: snapshot([target(id, "a<b>&c", "line1\nline2\u0000\u001b")]) },
      false,
    )

    expect(text).toContain("<name>a&lt;b&gt;&amp;c</name>")
    expect(text).toContain("<description>line1\\nline2\\u0000\\u001b</description>")
    expect(text).not.toContain("a<b>")
    expect(text).not.toContain("\u0000")
  })

  test("clips oversized fields with a truncation marker", () => {
    const id = "bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9"
    const long = "x".repeat(600)
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot([target(id, long, long)]) }, false)

    expect(text).not.toContain(long)
    expect(text).toContain("…")
  })

  test("bounds total output and marks omitted targets", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      target(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `target-${index}`,
        "d".repeat(200),
      ),
    )
    const text = renderAvailableTargets({ kind: "ok", snapshot: snapshot(many) }, false)

    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_AVAILABLE_TARGETS_BYTES)
    expect(text).toContain("additional target(s) omitted")
    expect(text).toContain("</available-targets>")
  })

  test("renders invalid registry diagnostics instead of an empty list", () => {
    const text = renderAvailableTargets(
      {
        kind: "ok",
        snapshot: {
          path: "/config/targets.jsonc",
          revision: "rev",
          targets: [],
          diagnostics: [{ severity: "error", path: "$.targets", message: "Expected an object" }],
          valid: false,
        },
      },
      false,
    )

    expect(text).toContain("<invalid-registry>")
    expect(text).toContain("Expected an object")
    expect(text).not.toContain("<selector>local</selector>")
  })

  test("renders a clear unavailable marker when the registry fails to load", () => {
    const text = renderAvailableTargets({ kind: "error" }, false)

    expect(text).toContain("<unavailable>")
    expect(text).not.toContain("<selector>local</selector>")
  })
})

describe("escapeField", () => {
  test("escapes all C0 controls deterministically", () => {
    expect(escapeField("\u0001\u001f")).toBe("\\u0001\\u001f")
    expect(escapeField("\n\r\t")).toBe("\\n\\r\\t")
    expect(escapeField("&<>")).toBe("&amp;&lt;&gt;")
  })
})

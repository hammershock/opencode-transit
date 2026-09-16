import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { HarnessInstructions } from "@opencode-ai/core/harness/instructions"
import { Location } from "@opencode-ai/core/location"
import { tmpdir } from "./fixture/tmpdir"

const first = Location.TargetID.make("11111111-1111-4111-8111-111111111111")
const second = Location.TargetID.make("22222222-2222-4222-8222-222222222222")

describe("HarnessInstructions", () => {
  test("preserves default global discovery and leaves an unbound target empty", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const home = path.join(root.path, "home")
    const canonical = path.join(config, "AGENTS.md")
    const fallback = path.join(home, ".claude", "CLAUDE.md")
    await fs.mkdir(path.dirname(fallback), { recursive: true })
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(canonical, "canonical")
    await fs.writeFile(fallback, "fallback")
    const settings = HarnessInstructions.make({ directory: config, home, lockDirectory: path.join(root.path, "locks") })

    expect(await settings.list()).toMatchObject({ version: 1, global: undefined, targets: [], valid: true })
    expect(await settings.read({ type: "global" })).toMatchObject({
      mode: "default",
      source: { resolved: canonical, status: "readable", content: "canonical" },
    })
    expect(await settings.read({ type: "target", target: "local" })).toMatchObject({ mode: "unset" })

    await fs.rm(canonical)
    expect(await settings.read({ type: "global" })).toMatchObject({
      mode: "default",
      source: { resolved: fallback, status: "readable", content: "fallback" },
    })
  })

  test("resolves controller references and mutates shared bindings atomically", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const home = path.join(root.path, "home")
    const relative = path.join(config, "policies", "global.md")
    const shared = path.join(home, "shared", "target.md")
    await fs.mkdir(path.dirname(relative), { recursive: true })
    await fs.mkdir(path.dirname(shared), { recursive: true })
    await fs.writeFile(relative, "global policy")
    await fs.writeFile(shared, "shared target policy")
    const settings = HarnessInstructions.make({ directory: config, home, lockDirectory: path.join(root.path, "locks") })
    const initial = await settings.list()
    const global = await settings.bind({
      scope: { type: "global" },
      reference: "policies/global.md",
      expectedRevision: initial.revision,
    })
    const one = await settings.bind({
      scope: { type: "target", target: first },
      reference: "~/shared/target.md",
      expectedRevision: global.revision,
    })
    const two = await settings.bind({
      scope: { type: "target", target: second },
      reference: shared,
      expectedRevision: one.revision,
    })

    expect(await settings.read({ type: "global" })).toMatchObject({
      mode: "custom",
      source: { reference: "policies/global.md", resolved: relative, content: "global policy" },
    })
    expect(await settings.read({ type: "target", target: first })).toMatchObject({
      mode: "custom",
      source: {
        resolved: shared,
        content: "shared target policy",
        sharedTargets: [first, second],
      },
    })
    expect(await settings.validate("~/shared/target.md")).toMatchObject({
      resolved: shared,
      status: "readable",
      sharedTargets: [first, second],
    })
    expect((await fs.stat(two.path)).mode & 0o777).toBe(0o600)

    const unbound = await settings.unbind({ target: first, expectedRevision: two.revision })
    expect(unbound.targets).toEqual([{ target: second, reference: shared }])
    expect(await fs.readFile(shared, "utf8")).toBe("shared target policy")
    const reset = await settings.resetGlobal(unbound.revision)
    expect(reset.global).toBeUndefined()
    await expect(
      settings.bind({ scope: { type: "target", target: first }, reference: shared, expectedRevision: two.revision }),
    ).rejects.toHaveProperty("_tag", "HarnessInstructions.RevisionConflictError")
  })

  test("reports explicit missing and unreadable custom files without fallback", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const home = path.join(root.path, "home")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "AGENTS.md"), "default must not apply")
    await fs.mkdir(path.join(config, "directory.md"))
    const settings = HarnessInstructions.make({ directory: config, home, lockDirectory: path.join(root.path, "locks") })
    const initial = await settings.list()
    const global = await settings.bind({
      scope: { type: "global" },
      reference: "missing.md",
      expectedRevision: initial.revision,
    })
    await settings.bind({
      scope: { type: "target", target: "local" },
      reference: "directory.md",
      expectedRevision: global.revision,
    })

    expect(await settings.read({ type: "global" })).toMatchObject({
      mode: "custom",
      source: { status: "missing" },
    })
    expect(await settings.read({ type: "target", target: "local" })).toMatchObject({
      mode: "custom",
      source: { status: "unreadable" },
    })
  })

  test("diagnoses invalid version, targets, and references without overwriting settings", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const file = path.join(config, "harness.jsonc")
    const text = `{
  "version": 2,
  "instructions": {
    "global": " bad ",
    "targets": { "not-a-target": "rules.md" }
  }
}\n`
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(file, text)
    const settings = HarnessInstructions.make({
      directory: config,
      home: root.path,
      lockDirectory: path.join(root.path, "locks"),
    })
    const snapshot = await settings.list()

    expect(snapshot.valid).toBe(false)
    expect(snapshot.diagnostics.map((item) => item.kind).toSorted()).toEqual([
      "invalid-reference",
      "invalid-target",
      "unsupported-version",
    ])
    expect(await settings.read({ type: "global" })).toMatchObject({ mode: "invalid" })
    await expect(settings.resetGlobal(snapshot.revision)).rejects.toHaveProperty(
      "_tag",
      "HarnessInstructions.InvalidConfigError",
    )
    expect(await fs.readFile(file, "utf8")).toBe(text)
  })

  test("diagnoses an unreadable settings source without replacing it", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const file = path.join(config, "harness.jsonc")
    await fs.mkdir(file, { recursive: true })
    const settings = HarnessInstructions.make({
      directory: config,
      home: root.path,
      lockDirectory: path.join(root.path, "locks"),
    })
    const snapshot = await settings.list()

    expect(snapshot).toMatchObject({ valid: false, diagnostics: [{ kind: "invalid-config", field: file }] })
    await expect(settings.resetGlobal(snapshot.revision)).rejects.toHaveProperty(
      "_tag",
      "HarnessInstructions.InvalidConfigError",
    )
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  })
})

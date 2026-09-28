import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillSettings } from "@opencode-ai/core/skill/settings"
import { Location } from "@opencode-ai/core/location"
import { tmpdir } from "./fixture/tmpdir"

const skillID = Skill.ID.make(`skl_${"1".repeat(64)}`)
const targetID = Location.TargetID.make("9a858c60-01c7-4a3d-a137-f5df09560d42")

describe("SkillSettings", () => {
  test("starts with only OpenCode default roots", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const snapshot = await SkillSettings.make({ directory: config, home: root.path }).load()

    expect(snapshot.valid).toBe(true)
    expect(String(snapshot.path)).toBe(path.join(config, "opencode.jsonc"))
    expect(snapshot.roots).toEqual([
      expect.objectContaining({
        kind: "opencode-global",
        value: path.join(config, "skill"),
        default: true,
        status: "undetected",
      }),
      expect.objectContaining({
        kind: "opencode-global",
        value: path.join(config, "skills"),
        default: true,
        status: "undetected",
      }),
    ])
    expect(snapshot.targets).toEqual({})
  })

  test("updates imported roots atomically and preserves JSONC fields, comments, and target scopes", async () => {
    if (process.platform === "win32") return
    await using root = await tmpdir()
    const imported = path.join(root.path, "codex", "skills")
    const config = path.join(root.path, "config")
    const file = path.join(config, "opencode.jsonc")
    await fs.mkdir(imported, { recursive: true })
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(
      file,
      `{
  // keep this comment
  "future": { "enabled": true },
  "skills": {
    "paths": [],
    "urls": [],
    "futureSkillOption": "keep",
    // keep target comment
    "targets": { "${skillID}": ["local", "${targetID}"] }
  }
}\n`,
      { mode: 0o640 },
    )
    let invalidations = 0
    const settings = SkillSettings.make({
      directory: config,
      home: root.path,
      targetIDs: async () => new Set<string>(),
      invalidate: async () => {
        invalidations++
      },
    })
    const initial = await settings.load()

    expect(initial.diagnostics).toContainEqual(expect.objectContaining({ kind: "missing-target", skillID, targetID }))
    const updated = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({
        paths: [imported, imported],
        urls: ["https://example.test/skills", "https://example.test/skills"],
        expectedRevision: initial.revision,
      }),
    )

    expect(updated.roots.filter((item) => !item.default).map((item) => item.value)).toEqual([
      imported,
      "https://example.test/skills",
    ])
    expect(updated.targets[skillID]).toEqual(["local", targetID])
    const scoped = await settings.updateTargetScope(skillID, "*", updated.revision)
    expect(scoped.targets[skillID]).toBe("*")
    expect(invalidations).toBe(1)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"future": { "enabled": true }')
    expect(text).toContain('"futureSkillOption": "keep"')
    expect(text).toContain("// keep target comment")
  })

  test("reset removes configured sources without deleting packages or dormant target scopes", async () => {
    await using root = await tmpdir()
    const imported = path.join(root.path, "imported")
    const packageFile = path.join(imported, "review", "SKILL.md")
    await fs.mkdir(path.dirname(packageFile), { recursive: true })
    await fs.writeFile(packageFile, "---\nname: review\n---\nReview")
    const settings = SkillSettings.make({ directory: path.join(root.path, "config"), home: root.path })
    const initial = await settings.load()
    const updated = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({ paths: [imported], urls: [], expectedRevision: initial.revision }),
    )
    const scoped = await settings.updateTargetScope(skillID, [], updated.revision)
    const reset = await settings.resetDiscovery(scoped.revision)

    expect(reset.roots.every((item) => item.default)).toBe(true)
    expect(reset.targets[skillID]).toEqual([])
    expect(await fs.readFile(packageFile, "utf8")).toContain("Review")
  })

  test("rejects stale revisions and invalid discovery values without partial writes", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const settings = SkillSettings.make({ directory: config, home: root.path })
    const initial = await settings.load()
    const accepted = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({ paths: ["missing"], urls: [], expectedRevision: initial.revision }),
    )

    await expect(
      settings.updateDiscovery(
        Skill.DiscoveryUpdate.make({ paths: ["other"], urls: [], expectedRevision: initial.revision }),
      ),
    ).rejects.toHaveProperty("_tag", "SkillSettings.RevisionConflictError")
    await expect(
      settings.updateDiscovery(
        Skill.DiscoveryUpdate.make({ paths: [" bad "], urls: [], expectedRevision: accepted.revision }),
      ),
    ).rejects.toHaveProperty("_tag", "SkillSettings.InvalidPathError")
    await expect(
      settings.updateDiscovery(
        Skill.DiscoveryUpdate.make({ paths: [], urls: ["file:///tmp/skills"], expectedRevision: accepted.revision }),
      ),
    ).rejects.toHaveProperty("_tag", "SkillSettings.InvalidUrlError")
    expect((await settings.load()).revision).toBe(accepted.revision)
  })

  test("reports invalid configuration and refuses to overwrite it", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const file = path.join(config, "opencode.jsonc")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(file, '{ "skills": { "paths": "broken" } }')
    const settings = SkillSettings.make({ directory: config, home: root.path })
    const snapshot = await settings.load()

    expect(snapshot.valid).toBe(false)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-config" }))
    await expect(settings.resetDiscovery(snapshot.revision)).rejects.toHaveProperty(
      "_tag",
      "SkillSettings.InvalidConfigError",
    )
    expect(await fs.readFile(file, "utf8")).toBe('{ "skills": { "paths": "broken" } }')
  })

  test("treats an empty configuration file as invalid and refuses to overwrite it", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const file = path.join(config, "opencode.jsonc")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(file, "")
    const settings = SkillSettings.make({ directory: config, home: root.path })
    const snapshot = await settings.load()

    expect(snapshot.valid).toBe(false)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-config" }))
    await expect(
      settings.updateDiscovery(
        Skill.DiscoveryUpdate.make({ paths: [root.path], urls: [], expectedRevision: snapshot.revision }),
      ),
    ).rejects.toHaveProperty("_tag", "SkillSettings.InvalidConfigError")
    expect(await fs.readFile(file, "utf8")).toBe("")
  })
  test("retains inaccessible roots while allowing scope saves and path repair without losing other settings", async () => {
    if (process.platform === "win32") return
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    const broken = path.join(root.path, "broken")
    const healthy = path.join(root.path, "healthy")
    await fs.symlink(broken, broken)
    await fs.mkdir(healthy)
    await fs.mkdir(config)
    await fs.writeFile(
      path.join(config, "opencode.jsonc"),
      JSON.stringify({
        future: true,
        skills: { paths: [broken, healthy], targets: { [skillID]: [targetID] } },
      }),
    )
    let scans = 0
    const settings = SkillSettings.make({
      directory: config,
      home: root.path,
      invalidate: async () => {
        scans++
      },
    })
    const initial = await settings.load()
    expect(initial.valid).toBe(true)
    expect(initial.roots).toContainEqual(expect.objectContaining({ value: broken, status: "unavailable" }))
    expect(initial.diagnostics).toContainEqual(
      expect.objectContaining({
        field: "skills.paths.0",
        severity: "warning",
        message: "Skill directory is unavailable (ELOOP)",
      }),
    )
    const scoped = await settings.updateTargetScope(skillID, ["local"], initial.revision)
    expect(scans).toBe(0)
    expect(scoped.targets[skillID]).toEqual(["local"])
    const extended = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({
        paths: [broken, healthy, "missing"],
        urls: [],
        expectedRevision: scoped.revision,
      }),
    )
    expect(extended.valid).toBe(true)
    expect(extended.roots.find((item) => item.value === broken)?.status).toBe("unavailable")
    expect(extended.roots.at(-1)?.status).toBe("undetected")
    const repaired = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({
        paths: [healthy],
        urls: [],
        expectedRevision: extended.revision,
      }),
    )
    expect(scans).toBe(2)
    expect(repaired.roots.filter((item) => !item.default).map((item) => item.value)).toEqual([healthy])
    expect(repaired.targets[skillID]).toEqual(["local"])
    expect((await fs.lstat(broken)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(config, "opencode.jsonc"), "utf8")).future).toBe(true)
  })

  test("shows a non-directory and a malformed path so they can be removed", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    await fs.mkdir(config)
    const file = path.join(root.path, "file")
    await fs.writeFile(file, "keep")
    await fs.writeFile(path.join(config, "opencode.jsonc"), JSON.stringify({ skills: { paths: [file, " bad "] } }))
    const settings = SkillSettings.make({ directory: config, home: root.path })
    const initial = await settings.load()
    expect(initial.valid).toBe(true)
    expect(initial.roots.filter((item) => !item.default)).toEqual([
      expect.objectContaining({ value: file, status: "unavailable" }),
      expect.objectContaining({ value: " bad ", status: "unavailable" }),
    ])
    const updated = await settings.updateDiscovery(
      Skill.DiscoveryUpdate.make({ paths: [], urls: [], expectedRevision: initial.revision }),
    )
    expect(updated.valid).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe("keep")
  })
})

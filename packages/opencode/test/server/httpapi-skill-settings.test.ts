import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>
const configFile = path.join(Global.Path.config, "opencode.jsonc")

function request(route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

afterEach(async () => {
  await fs.rm(configFile, { force: true })
})

describe("Skill settings HttpApi", () => {
  test("Agent scope API keeps frozen previews until reload and intersects target access", async () => {
    await using tmp = await tmpdir({ git: true })
    const imported = path.join(tmp.path, "skills")
    await fs.mkdir(path.join(imported, "review"), { recursive: true })
    await fs.writeFile(
      path.join(imported, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nReview.",
    )
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(
      configFile,
      JSON.stringify({
        skills: { paths: [imported] },
        agent: { "stable-reviewer": { name: "Paper Reviewer", mode: "subagent" } },
      }),
    )
    const location = new URLSearchParams({ "location[directory]": tmp.path })
    const preview = async (agent: string, reload = false) => {
      const result = await request(`/api/skill/catalog?${location}&agent=${agent}&forceReload=${reload}`)
      expect(result.status).toBe(200)
      return (await result.json()).data.skills as Array<{ id: string; name: string }>
    }
    const initial = await (await request("/api/skill/settings")).json()
    const skill = (await preview("build", true)).find((skill) => skill.name === "review")!
    expect(skill).toBeDefined()
    const names = await (await request(`/api/agent?${location}`)).json()
    expect(names.data).toContainEqual(expect.objectContaining({ id: "stable-reviewer", name: "Paper Reviewer" }))
    const scopedResponse = await request(`/api/skill/settings/${skill.id}/agent-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: ["stable-reviewer"], expectedRevision: initial.revision }),
    })
    expect(scopedResponse.status).toBe(200)
    const scoped = await scopedResponse.json()
    expect(scoped.agents[skill.id]).toEqual(["stable-reviewer"])
    expect((await preview("build")).some((item) => item.id === skill.id)).toBe(true)
    expect((await preview("build", true)).some((item) => item.id === skill.id)).toBe(false)
    expect((await preview("stable-reviewer")).some((item) => item.id === skill.id)).toBe(true)
    expect(await preview("missing-agent")).toEqual([])
    expect(
      (
        await request(`/api/skill/settings/${skill.id}/agent-scope`, {
          method: "PUT",
          body: JSON.stringify({ scope: "*", expectedRevision: initial.revision }),
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request(`/api/skill/settings/${skill.id}/agent-scope`, {
          method: "PUT",
          body: JSON.stringify({ scope: ["*"], expectedRevision: scoped.revision }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(`/api/skill/settings/${skill.id}/target-scope`, {
          method: "PUT",
          body: JSON.stringify({ scope: [], expectedRevision: scoped.revision }),
        })
      ).status,
    ).toBe(200)
    expect((await preview("stable-reviewer", true)).some((item) => item.id === skill.id)).toBe(false)
  })

  test("unavailable roots remain manageable without blocking a healthy catalog or target access", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    const broken = path.join(tmp.path, "broken")
    const healthy = path.join(tmp.path, "healthy")
    await fs.symlink(broken, broken)
    await fs.mkdir(path.join(healthy, "review"), { recursive: true })
    await fs.writeFile(path.join(healthy, "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview.")
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(configFile, JSON.stringify({ skills: { paths: [broken, healthy] } }))
    const initial = await (await request("/api/skill/settings")).json()
    expect(initial.valid).toBe(true)
    expect(initial.roots).toContainEqual(expect.objectContaining({ value: broken, status: "unavailable" }))
    const location = new URLSearchParams({
      "location[directory]": tmp.path,
      forceReload: "true",
      includeInactive: "true",
    })
    const catalogResponse = await request(`/api/skill/catalog?${location}`)
    expect(catalogResponse.status).toBe(200)
    const catalog = await catalogResponse.json()
    const skill = catalog.data.skills.find((skill: { name: string }) => skill.name === "review")
    expect(skill).toBeDefined()
    const scopedResponse = await request(`/api/skill/settings/${skill.id}/target-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: ["local"], expectedRevision: initial.revision }),
    })
    expect(scopedResponse.status).toBe(200)
    const scoped = await scopedResponse.json()
    const repaired = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [healthy], urls: [], expectedRevision: scoped.revision }),
    })
    expect(repaired.status).toBe(200)
    expect((await repaired.json()).targets[skill.id]).toEqual(["local"])
    expect((await fs.lstat(broken)).isSymbolicLink()).toBe(true)
  })

  test("updates, scopes, reloads, and resets device-local Skill settings with CAS", async () => {
    await using tmp = await tmpdir({ git: true })
    const workspace = tmp.path
    const imported = path.join(workspace, "imported")
    const importedDuplicate = path.join(workspace, "imported-duplicate")
    const packageFile = path.join(imported, "review", "SKILL.md")
    const duplicatePackageFile = path.join(importedDuplicate, "review", "SKILL.md")
    await fs.mkdir(path.dirname(packageFile), { recursive: true })
    await fs.mkdir(path.dirname(duplicatePackageFile), { recursive: true })
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(
      packageFile,
      "---\nname: review\ndescription: Review changes through the API\n---\nReview carefully.",
    )
    await fs.writeFile(
      duplicatePackageFile,
      "---\nname: review\ndescription: A different review Skill\n---\nUse the duplicate body.",
    )
    await fs.writeFile(configFile, '{\n  // preserve me\n  "future": true\n}\n')

    const initialResponse = await request("/api/skill/settings")
    expect(initialResponse.status).toBe(200)
    const initial = (await initialResponse.json()) as { revision: string; roots: Array<{ default: boolean }> }
    expect(initial.roots).toHaveLength(2)
    expect(initial.roots.every((root) => root.default)).toBe(true)

    const updateResponse = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [imported, importedDuplicate], urls: [], expectedRevision: initial.revision }),
    })
    expect(updateResponse.status).toBe(200)
    const updated = (await updateResponse.json()) as {
      revision: string
      roots: Array<{ kind: string; value: string; default: boolean }>
    }
    expect(updated.roots).toContainEqual(expect.objectContaining({ kind: "imported", value: imported, default: false }))
    expect(await fs.readFile(configFile, "utf8")).toContain("// preserve me")

    const stale = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [], urls: [], expectedRevision: initial.revision }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ _tag: "ConflictError" })

    const location = new URLSearchParams({ "location[directory]": workspace })
    const reloadResponse = await request(`/api/skill/reload?${location}`, { method: "POST" })
    expect(reloadResponse.status).toBe(200)
    const reloaded = (await reloadResponse.json()) as { data: { skills: Array<{ id: string; name: string }> } }
    const skill = reloaded.data.skills.find(
      (item) =>
        item.name === "review" && "description" in item && item.description === "Review changes through the API",
    )
    expect(skill).toBeDefined()
    expect(skill).not.toHaveProperty("content")

    const detailResponse = await request(`/api/skill/${skill!.id}?${location}`)
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({
      data: {
        metadata: {
          id: skill!.id,
          name: "review",
          description: "Review changes through the API",
        },
        location: packageFile,
        content: "Review carefully.",
      },
    })

    const missingResponse = await request(`/api/skill/skl_${"f".repeat(64)}?${location}`)
    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toMatchObject({ _tag: "SkillNotFoundError" })

    const scopeResponse = await request(`/api/skill/settings/${skill!.id}/target-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: [], expectedRevision: updated.revision }),
    })
    expect(scopeResponse.status).toBe(200)
    const scoped = (await scopeResponse.json()) as { revision: string; targets: Record<string, unknown> }
    expect(scoped.targets[skill!.id]).toEqual([])

    const inactiveDetail = await request(`/api/skill/${skill!.id}?${location}`)
    expect(inactiveDetail.status).toBe(200)

    await fs.writeFile(
      packageFile,
      "---\nname: review\ndescription: Review changes through the API\n---\nChanged after catalog load.",
    )
    const staleDetail = await request(`/api/skill/${skill!.id}?${location}`)
    expect(staleDetail.status).toBe(409)
    expect(await staleDetail.json()).toMatchObject({ _tag: "ConflictError", resource: "skill_catalog" })

    const filtered = (await (await request(`/api/skill/catalog?${location}&forceReload=true`)).json()) as {
      data: { skills: Array<{ id: string; name: string }> }
    }
    expect(filtered.data.skills.some((item) => item.id === skill!.id)).toBe(false)
    expect(filtered.data.skills.some((item) => item.name === "review")).toBe(true)

    const management = (await (
      await request(`/api/skill/catalog?${location}&forceReload=true&includeInactive=true`)
    ).json()) as {
      data: { skills: Array<{ name: string }> }
    }
    expect(management.data.skills.some((item) => item.name === "review")).toBe(true)

    const invalidScope = await request(`/api/skill/settings/${skill!.id}/target-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: ["not-a-target"], expectedRevision: scoped.revision }),
    })
    expect(invalidScope.status).toBe(400)

    const invalidPath = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [" invalid "], urls: [], expectedRevision: scoped.revision }),
    })
    expect(invalidPath.status).toBe(400)
    expect(await invalidPath.json()).toMatchObject({ _tag: "InvalidRequestError", kind: "skill_path" })

    const resetResponse = await request("/api/skill/settings/discovery/reset", {
      method: "POST",
      body: JSON.stringify({ expectedRevision: scoped.revision }),
    })
    expect(resetResponse.status).toBe(200)
    const reset = (await resetResponse.json()) as {
      roots: Array<{ default: boolean }>
      targets: Record<string, unknown>
    }
    expect(reset.roots.every((root) => root.default)).toBe(true)
    expect(reset.targets[skill!.id]).toEqual([])
    expect(await fs.readFile(packageFile, "utf8")).toContain("Changed after catalog load")
  })
})

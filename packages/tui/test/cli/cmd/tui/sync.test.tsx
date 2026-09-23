/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("projects a Location rebind and persists its user-visible notice", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const session = {
      id: "ses_rebound",
      slug: "rebound",
      projectID: "proj_test",
      directory: "/old",
      title: "Rebound session",
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const mounted = await mount((url) => {
      if (url.pathname === "/session") return json([session])
    }, tmp.path)

    try {
      mounted.emit({
        directory: "/new",
        project: "proj_test",
        payload: {
          id: "evt_rebound",
          type: "session.next.location.rebound",
          properties: {
            timestamp: 2,
            sessionID: session.id,
            previous: { directory: "/old" },
            location: { directory: "/new" },
            revision: 1,
          },
        },
      })
      await wait(() => mounted.sync.data.session[0]?.directory === "/new")

      expect(mounted.sync.data.session[0]).toMatchObject({ directory: "/new", time: { updated: 2 } })
      expect(mounted.kv.get(`session_location_changed:${session.id}`)).toEqual({
        revision: 1,
        previous: { directory: "/old" },
        location: { directory: "/new" },
      })
    } finally {
      mounted.app.renderer.destroy()
    }
  })

  test("auto permission replies preserve legacy targets and use canonical Session routes", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const replies: Request[] = []
    const session = {
      id: "ses_remote_auto",
      slug: "remote-auto",
      projectID: "proj_test",
      directory: "/remote/project",
      title: "Remote auto",
      version: "test",
      time: { created: 1, updated: 1 },
      approvalMode: "auto",
      target: { type: "rexd", targetID: "target-test" },
    }
    const mounted = await mount((url, request) => {
      if (url.pathname === "/session") return json([session])
      if (url.pathname.includes("/permission/")) {
        replies.push(request)
        return json(true)
      }
    }, tmp.path)

    try {
      mounted.emit({
        directory: session.directory,
        project: session.projectID,
        payload: {
          id: "evt_legacy_permission",
          type: "permission.asked",
          properties: {
            id: "permission-legacy",
            sessionID: session.id,
            permission: "external_directory",
            patterns: ["/outside/*"],
            always: ["/outside/*"],
            metadata: {},
          },
        },
      })
      await wait(() => replies.length === 1)
      expect(new URL(replies[0]!.url).pathname).toBe("/permission/permission-legacy/reply")
      expect(replies[0]!.headers.get("x-opencode-target")).toBe(session.target.targetID)

      mounted.emit({
        directory: session.directory,
        project: session.projectID,
        payload: {
          id: "evt_v2_permission",
          type: "permission.v2.asked",
          properties: {
            id: "permission-v2",
            sessionID: session.id,
            action: "external_directory",
            resources: ["/outside/*"],
          },
        },
      })
      await wait(() => replies.length === 2)
      expect(new URL(replies[1]!.url).pathname).toBe(`/api/session/${session.id}/permission/permission-v2/reply`)
      expect(replies[1]!.headers.has("x-opencode-target")).toBe(false)
    } finally {
      mounted.app.renderer.destroy()
    }
  })

  test("auto permission replies resolve uncached subagent sessions", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const replies: Request[] = []
    const legacy = {
      id: "ses_legacy_child",
      parentID: "ses_parent",
      slug: "legacy-child",
      projectID: "proj_test",
      directory: "/remote/project",
      title: "Legacy child",
      version: "test",
      time: { created: 1, updated: 1 },
      approvalMode: "auto",
      target: { type: "rexd" as const, targetID: "target-child" },
    }
    const v2 = {
      ...legacy,
      id: "ses_v2_child",
      slug: "v2-child",
      title: "V2 child",
      target: undefined,
      directory: "/local/project",
    }
    const mounted = await mount((url, request) => {
      if (url.pathname === "/session") return json([{ ...legacy, approvalMode: undefined }])
      if (url.pathname === `/session/${legacy.id}`) return json(legacy)
      if (url.pathname === `/session/${v2.id}`) return json(v2)
      if (url.pathname.includes("/permission/")) {
        replies.push(request)
        return json(true)
      }
    }, tmp.path)

    try {
      mounted.emit({
        directory: legacy.directory,
        project: legacy.projectID,
        payload: {
          id: "evt_uncached_legacy_permission",
          type: "permission.asked",
          properties: {
            id: "permission-uncached-legacy",
            sessionID: legacy.id,
            permission: "external_directory",
            patterns: ["/outside/*"],
            always: ["/outside/*"],
            metadata: {},
          },
        },
      })
      await wait(() => replies.length === 1)
      expect(new URL(replies[0]!.url).pathname).toBe("/permission/permission-uncached-legacy/reply")
      expect(replies[0]!.headers.get("x-opencode-target")).toBe(legacy.target.targetID)

      mounted.emit({
        directory: v2.directory,
        project: v2.projectID,
        payload: {
          id: "evt_uncached_v2_permission",
          type: "permission.v2.asked",
          properties: {
            id: "permission-uncached-v2",
            sessionID: v2.id,
            action: "external_directory",
            resources: ["/outside/*"],
          },
        },
      })
      await wait(() => replies.length === 2)
      expect(new URL(replies[1]!.url).pathname).toBe(`/api/session/${v2.id}/permission/permission-uncached-v2/reply`)
      expect(mounted.sync.data.session).toEqual([
        expect.objectContaining({ id: legacy.id, approvalMode: "auto" }),
        expect.objectContaining({ id: v2.id, approvalMode: "auto" }),
      ])
    } finally {
      mounted.app.renderer.destroy()
    }
  })

  test("uncached normal subagent permissions remain pending", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const child = {
      id: "ses_normal_child",
      parentID: "ses_parent",
      slug: "normal-child",
      projectID: "proj_test",
      directory: "/local/project",
      title: "Normal child",
      version: "test",
      time: { created: 1, updated: 1 },
      approvalMode: "normal",
    }
    const mounted = await mount((url) => {
      if (url.pathname === `/session/${child.id}`) return json(child)
    }, tmp.path)

    try {
      mounted.emit({
        directory: child.directory,
        project: child.projectID,
        payload: {
          id: "evt_uncached_normal_permission",
          type: "permission.v2.asked",
          properties: {
            id: "permission-uncached-normal",
            sessionID: child.id,
            action: "external_directory",
            resources: ["/outside/*"],
          },
        },
      })
      await wait(() => mounted.sync.data.permission[child.id]?.length === 1)

      expect(mounted.sync.data.session).toContainEqual(expect.objectContaining({ id: child.id }))
      expect(mounted.sync.data.permission[child.id]).toEqual([
        expect.objectContaining({ id: "permission-uncached-normal", api: "v2" }),
      ])
    } finally {
      mounted.app.renderer.destroy()
    }
  })

  test("permissions remain pending when an uncached Session cannot be resolved", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const childID = "ses_missing_child"
    const mounted = await mount((url) => {
      if (url.pathname === `/session/${childID}`) return json({ message: "missing" }, { status: 404 })
    }, tmp.path)

    try {
      mounted.emit({
        directory: "/local/project",
        project: "proj_test",
        payload: {
          id: "evt_missing_child_permission",
          type: "permission.v2.asked",
          properties: {
            id: "permission-missing-child",
            sessionID: childID,
            action: "external_directory",
            resources: ["/outside/*"],
          },
        },
      })
      await wait(() => mounted.sync.data.permission[childID]?.length === 1)

      expect(mounted.sync.data.permission[childID]).toEqual([
        expect.objectContaining({ id: "permission-missing-child", api: "v2" }),
      ])
    } finally {
      mounted.app.renderer.destroy()
    }
  })
})

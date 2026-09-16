import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  SESSION_FILTER_FOOTER_HINT,
  dialogSessionListSyncStatus,
  dialogSessionListTargetOptions,
  fromSyncedSession,
  loadDialogSessionList,
  mergeDialogSessions,
  sessionInDialogPath,
  sessionInDialogTarget,
  syncAvailabilityLabel,
  syncedSessionNeedsHydration,
  updateDialogSessionListFilters,
} from "../../src/component/dialog-session-list"
import { sessionListMatches } from "../../src/component/session-list-location"

const cloud = (sessionID: string, directory = "/repo", targetLabel = "gpu") => ({
  sessionID,
  title: sessionID,
  ownerDeviceID: "device",
  sourceDeviceID: "device",
  directory,
  targetLabel,
  updatedAt: 1,
  availability: "metadata-only" as const,
})

describe("dialog session list", () => {
  test("clears inherited SDK Location headers before the global request", async () => {
    const requests: Request[] = []
    const sdk = createOpencodeClient({
      baseUrl: "http://localhost",
      directory: "/launcher",
      experimental_workspaceID: "workspace",
      experimental_targetID: "target",
      fetch: (async (request) => {
        requests.push(request as Request)
        return Response.json([])
      }) as typeof fetch,
    })
    expect(
      await loadDialogSessionList({ list: (query, options) => sdk.experimental.session.list(query, options) }),
    ).toEqual([])
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/experimental/session")
    expect([...url.searchParams.keys()].sort()).toEqual(["archived", "limit"])
    expect(requests[0]!.headers.has("x-opencode-directory")).toBe(false)
  })
  test("advertises Tab as the filter-row navigation key", () => {
    expect(SESSION_FILTER_FOOTER_HINT).toEqual({ title: "tab", label: "filters" })
  })

  test("loads all projects beyond a timestamp tie without server-side title/path/root filtering", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: String(index),
      title: "title",
      directory: index === 204 ? "/other-project" : "/repo",
      time: { updated: 42 },
    }))
    const queries: unknown[] = []
    const result = await loadDialogSessionList({
      list: async (query) => {
        queries.push(query)
        return { data: rows.slice(0, query.limit) }
      },
    })
    expect(result).toEqual(rows)
    expect(queries).toEqual([100, 200, 400].map((limit) => ({ limit, archived: true })))
    expect(result?.filter((row) => sessionListMatches(row, "other-project")).map((row) => row.id)).toEqual(["204"])
  })

  test("keeps the cache usable while the global request is pending", async () => {
    const deferred = Promise.withResolvers<{ data: string[] }>()
    const pending = loadDialogSessionList({ list: () => deferred.promise })
    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    deferred.resolve({ data: ["root"] })
    expect(await pending).toEqual(["root"])
  })

  test("returns fallback on failures, including failure after the initial prefix", async () => {
    expect(await loadDialogSessionList({ list: async () => ({}) })).toBeUndefined()
    expect(await loadDialogSessionList({ list: () => Promise.reject(new Error("offline")) })).toBeUndefined()
    expect(
      await loadDialogSessionList({
        list: async (query) => (query.limit === 100 ? { data: Array.from({ length: 100 }, () => "row") } : {}),
      }),
    ).toBeUndefined()
  })

  test("changes only the focused filter and preserves every Cartesian combination", () => {
    const targets = ["local", "all", "gpu"]
    for (const cwd of ["cwd", "all"] as const) {
      for (const target of targets) {
        const initial = { focus: "cwd" as const, cwd, target }
        expect(updateDialogSessionListFilters(initial, "right", targets)).toEqual({
          ...initial,
          cwd: cwd === "cwd" ? "all" : "cwd",
        })
        const focused = updateDialogSessionListFilters(initial, "tab", targets)
        expect(focused).toEqual({ ...initial, focus: "target" })
        expect(updateDialogSessionListFilters(focused, "right", targets)).toEqual({
          ...focused,
          target: targets[(targets.indexOf(target) + 1) % targets.length],
        })
      }
    }
  })

  test("applies independent Path/Target filters to the merged local and cloud union", () => {
    const sessions = mergeDialogSessions(
      [
        { id: "local-cwd", title: "Local", directory: "/repo", time: { updated: 3 } },
        { id: "local-other", title: "Other project", directory: "/other", time: { updated: 2 } },
        { id: "remote-local-row", title: "Remote", directory: "/repo", targetLabel: "gpu", time: { updated: 1 } },
      ],
      [cloud("cloud-cwd"), cloud("cloud-other", "/other"), cloud("cloud-local", "/repo", "local")],
    )
    const selected = (cwd: "cwd" | "all", target: string) =>
      sessions
        .filter((row) => sessionInDialogPath(row, cwd, "/repo"))
        .filter((row) => sessionInDialogTarget(row, target))
        .map((row) => row.id)
    expect(selected("all", "all")).toHaveLength(6)
    expect(selected("all", "local")).toEqual(["local-cwd", "local-other", "cloud-local"])
    expect(selected("cwd", "all")).toEqual(["local-cwd", "remote-local-row", "cloud-cwd", "cloud-local"])
    expect(selected("cwd", "gpu")).toEqual(["remote-local-row", "cloud-cwd"])
    expect(selected("all", "gpu")).toEqual(["remote-local-row", "cloud-cwd", "cloud-other"])
    expect(selected("cwd", "local")).toEqual(["local-cwd", "cloud-local"])
  })

  test("Cwd normalizes paths without including children or resolving a remote path on the host", () => {
    expect(sessionInDialogPath({ directory: "/repo/./" }, "cwd", "/repo")).toBe(true)
    expect(sessionInDialogPath({ directory: "/repo/child" }, "cwd", "/repo")).toBe(false)
    expect(sessionInDialogPath({ directory: "/repository" }, "cwd", "/repo")).toBe(false)
    expect(sessionInDialogPath({ directory: "/" }, "cwd", "/")).toBe(true)
    expect(sessionInDialogPath({ directory: "C:\\repo\\." }, "cwd", "C:\\repo")).toBe(true)
    expect(sessionInDialogPath({ directory: "/different" }, "all", "/repo")).toBe(true)
  })

  test("local projection wins and known children/archives/deletions cannot be reintroduced by cloud rows", () => {
    const local = (id: string) => ({
      id,
      title: "Current local title",
      directory: "/current",
      target: { type: "local" },
      time: { updated: 5 },
    })
    const rows = mergeDialogSessions(
      [
        local("root"),
        { ...local("child"), parentID: "root" },
        { ...local("archived"), time: { updated: 5, archived: 6 } },
        local("deleted"),
      ],
      [cloud("root"), cloud("child"), cloud("archived"), { ...cloud("deleted"), deleted: true }],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "root", title: "Current local title", directory: "/current" })
    expect(sessionInDialogTarget(rows[0]!, "local")).toBe(true)
    expect(rows[0]?.syncMetadata?.availability).toBe("metadata-only")
    expect(mergeDialogSessions([local("offline")], []).map((row) => row.id)).toEqual(["offline"])
  })

  test("keeps metadata-only portable targets discoverable without guessing from ownership", () => {
    const rows = mergeDialogSessions([], [cloud("foreign", "/repo", "other-device")])
    expect(sessionInDialogTarget(rows[0]!, "local")).toBe(false)
    expect(sessionInDialogTarget(rows[0]!, "all")).toBe(true)
    expect(sessionInDialogTarget(rows[0]!, "other-device")).toBe(true)
    expect(dialogSessionListTargetOptions(rows, "missing")).toEqual(["local", "all", "other-device", "missing"])
  })

  test("labels every metadata-first availability state", () => {
    expect(syncAvailabilityLabel("metadata-only")).toBe("◐ metadata-only")
    expect(syncAvailabilityLabel("hydrating")).toBe("◐ hydrating")
    expect(syncAvailabilityLabel("ready")).toBe("● ready")
    expect(syncAvailabilityLabel("partial")).toBe("! partial")
    expect(syncAvailabilityLabel("conflict")).toBe("! conflict")
    expect(syncAvailabilityLabel("unresolved")).toBe("! unresolved")
  })

  test("preserves cloud hydration and status behavior", () => {
    expect(fromSyncedSession(cloud("session")).cloudOnly).toBe(true)
    expect(syncedSessionNeedsHydration({ availability: "ready" })).toBe(false)
    expect(syncedSessionNeedsHydration({ availability: "conflict" })).toBe(false)
    expect(syncedSessionNeedsHydration({ availability: "partial" })).toBe(true)
    expect(dialogSessionListSyncStatus({ cloudOnly: true, syncMetadata: cloud("session") })).toBe("cloud")
    expect(
      dialogSessionListSyncStatus({ syncMetadata: { ...cloud("session"), availability: "ready" } }),
    ).toBeUndefined()
    expect(dialogSessionListSyncStatus({ syncMetadata: { ...cloud("session"), availability: "partial" } })).toBe(
      "! partial",
    )
    expect(dialogSessionListSyncStatus({})).toBeUndefined()
  })
})

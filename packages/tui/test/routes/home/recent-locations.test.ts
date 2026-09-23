import { describe, expect, test } from "bun:test"
import { recentLocations } from "../../../src/routes/home/recent-locations"

const session = (directory: string, updated: number) => ({ directory, time: { created: 0, updated } })

describe("recent QuickStart locations", () => {
  test("uses newest activity across projects, deduplicates target and directory, and preserves source rows", () => {
    const sessions = [session("/first", 1), session("/second", 2), session("/first", 3)]
    expect(recentLocations(sessions).map((row) => [row.directory, row.updated])).toEqual([
      ["/first", 3],
      ["/second", 2],
    ])
    expect(sessions.map((row) => row.time.updated)).toEqual([1, 2, 3])
  })

  test("remote identity is the stable ID, never a name or a local path", () => {
    const rows = recentLocations([
      session("/work", 1),
      { ...session("/work", 2), target: { type: "rexd", targetID: "a" }, lastKnownTargetName: "old" },
      { ...session("/work", 4), target: { type: "rexd", targetID: "a" }, lastKnownTargetName: "renamed" },
      { ...session("/work", 3), target: { type: "rexd", targetID: "b" }, lastKnownTargetName: "renamed" },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0].target).toEqual({ type: "rexd", targetID: "a", name: "renamed" })
    expect(new Set(rows.map((row) => row.key)).size).toBe(3)
    expect(rows[2].target).toEqual({ type: "local" })
  })

  test("omits child, archived, empty and unbound portable records", () => {
    expect(
      recentLocations([
        { ...session("/child", 1), parentID: "parent" },
        { ...session("/archive", 1), time: { created: 0, updated: 1, archived: 0 } },
        session("", 2),
        { ...session("/cloud", 3), portableTargetLabel: "remote" },
        session("/local", 0),
      ]).map((row) => row.directory),
    ).toEqual(["/local"])
  })

  test("keeps twenty distinct locations rather than twenty sessions", () => {
    expect(recentLocations(Array.from({ length: 50 }, (_, i) => session(`/work/${i % 25}`, i)))).toHaveLength(20)
    expect(recentLocations([])).toEqual([])
  })
})

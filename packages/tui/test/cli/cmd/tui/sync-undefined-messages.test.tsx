/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The failure must remain retryable instead of caching an empty transcript.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("a messages endpoint failure remains retryable", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      title: "broken",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    let requests = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`) {
        requests++
        return requests === 1
          ? json({}, { status: 500 })
          : json([
              {
                info: {
                  id: "msg_recovered",
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "build",
                  model: { providerID: "test", modelID: "model" },
                },
                parts: [{ id: "prt_recovered", sessionID, messageID: "msg_recovered", type: "text", text: "saved" }],
              },
            ])
      }
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      if (url.pathname === "/session") return json([sessionPayload])
      return undefined
    }, tmp.path)

    try {
      await expect(sync.session.sync(sessionID)).rejects.toBeDefined()
      await expect(sync.session.sync(sessionID)).resolves.toBeUndefined()
      expect(requests).toBe(2)
      expect(sync.data.part.msg_recovered?.[0]).toMatchObject({ type: "text", text: "saved" })
    } finally {
      app.renderer.destroy()
    }
  })
})

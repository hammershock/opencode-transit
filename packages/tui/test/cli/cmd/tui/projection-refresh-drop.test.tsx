/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_projection_drop"
const session = {
  id: sessionID,
  title: "drop",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("a projection refresh that omits the session transiently drops it from the store", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let getRequests = 0
  let releaseGet!: (response: Response) => void
  const pendingGet = new Promise<Response>((resolve) => {
    releaseGet = resolve
  })
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session") return json([])
    if (url.pathname === `/session/${sessionID}`) {
      getRequests++
      if (getRequests === 1) return json(session)
      return pendingGet
    }
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(sync.session.get(sessionID)).toBeDefined()

    emit(global({ id: "evt_projection", type: "sync.projection.updated", properties: { revision: 1 } }))
    await wait(() => getRequests === 2)

    expect(sync.session.get(sessionID)).toBeUndefined()
  } finally {
    releaseGet(json(session))
    app.renderer.destroy()
  }
})

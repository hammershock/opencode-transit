import { expect, test } from "bun:test"
import { promptBackend } from "../../src/util/prompt-backend"

test("prompt backend keeps old servers on the legacy route and rejects uncertain failures", async () => {
  const route: string[] = []
  const request = (response: Response) => async (pathname: string) => {
    route.push(pathname)
    return response
  }
  expect(await promptBackend("ses_old", request(new Response("", { status: 404 })))).toBe("legacy")
  expect(await promptBackend("ses_old", request(new Response("", { status: 501 })))).toBe("legacy")
  expect(await promptBackend("ses_new", request(Response.json({ data: "v2" })))).toBe("v2")
  expect(await promptBackend("ses_old", request(Response.json({ data: "legacy" })))).toBe("legacy")
  expect(route).toEqual([
    "/api/session/ses_old/prompt/backend",
    "/api/session/ses_old/prompt/backend",
    "/api/session/ses_new/prompt/backend",
    "/api/session/ses_old/prompt/backend",
  ])
  await expect(promptBackend("ses_new", request(new Response("", { status: 503 })))).rejects.toThrow("503")
  await expect(promptBackend("ses_new", request(Response.json({ data: "unsupported" })))).rejects.toThrow("Invalid")
})

import { expect, test } from "bun:test"
import { HttpServerRequest } from "effect/unstable/http"
import { instanceDirectory } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"

test("status target queries keep remote paths out of the controller Instance", () => {
  const request = HttpServerRequest.fromWeb(new Request("http://localhost/session/status"))
  expect(instanceDirectory(request, new URL("http://localhost/session/status?directory=/local/project"))).toBe(
    "/local/project",
  )
  expect(
    instanceDirectory(request, new URL("http://localhost/session/status?directory=/remote/project&target=target-1")),
  ).toBe(process.cwd())
  expect(
    instanceDirectory(
      HttpServerRequest.fromWeb(
        new Request("http://localhost/session/status", { headers: { "x-opencode-target": "target-1" } }),
      ),
      new URL("http://localhost/session/status?directory=/remote/project"),
    ),
  ).toBe(process.cwd())
})

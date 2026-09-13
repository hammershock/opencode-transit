import { describe, expect, test } from "bun:test"
import { createOpencodeClient, type LocationRef } from "@opencode-ai/sdk/v2"
import { locationKey, locationQuery } from "../../src/util/location-query"

describe("Location query", () => {
  test("keeps equal paths on different targets in separate cache entries", () => {
    const first = locationKey({ directory: "/work", target: { type: "rexd", targetID: "target-1" } })
    const second = locationKey({ directory: "/work", target: { type: "rexd", targetID: "target-2" } })

    expect(first).not.toBe(second)
  })

  test.each([
    [
      "local",
      { directory: "/work", target: { type: "local" } } satisfies LocationRef,
      "http://localhost/api/environment?location[directory]=%2Fwork",
    ],
    [
      "Rexd",
      {
        directory: "/work",
        workspaceID: "workspace-1",
        target: { type: "rexd", targetID: "target-1" },
      } satisfies LocationRef,
      "http://localhost/api/environment?location[directory]=%2Fwork&location[workspace]=workspace-1&location[target]=target-1",
    ],
  ])("serializes the %s Location without nested objects", async (_name, location, expected) => {
    let url = ""
    const captureFetch = Object.assign(
      async (request: RequestInfo | URL) => {
        url = request instanceof Request ? request.url : request.toString()
        return Response.json({
          location: {
            target: { type: "local" },
            directory: "/work",
            project: { id: "project", directory: "/work" },
          },
          data: { enabled: false, generation: 1, variables: [], sources: [] },
        })
      },
      { preconnect: fetch.preconnect },
    )
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: captureFetch,
    })

    await client.v2.environment.list({ location: locationQuery(location) }, { throwOnError: true })

    expect(url).toBe(expected)
  })
})

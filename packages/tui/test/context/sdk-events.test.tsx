import { expect, spyOn, test } from "bun:test"
import { createComponent, createRenderEffect, createRoot, createSignal } from "solid-js"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { RemoteStatusProvider } from "../../src/context/remote-status"
import { createEventSource, directory } from "../fixture/tui-sdk"

test.each([1, 2])(
  "subscriber failure at event %i cannot strand reactive updates or later subscribers",
  async (fault) => {
    const events = createEventSource()
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const [value, setValue] = createSignal(0)
    const frames: number[] = []
    const received: number[] = []
    const dispose = createRoot((dispose) => {
      createComponent(RemoteStatusProvider, {
        get children() {
          return createComponent(SDKProvider, {
            url: "http://test",
            events: events.source,
            get children() {
              const sdk = useSDK()
              createRenderEffect(() => frames.push(value()))
              sdk.event.on("event", () => setValue((value) => value + 1))
              sdk.event.on("event", () => {
                if (value() === fault) throw new Error("private event contents")
              })
              sdk.event.on("event", () => received.push(value()))
              return null
            },
          })
        },
      })
      return dispose
    })
    try {
      await Bun.sleep(0)
      // Catch the baseline dispatch error so we can inspect the lasting damage:
      // later writes must still render, even after the throwing handler is done.
      try {
        events.emit({ directory, payload: { id: "event-test", type: "server.connected", properties: {} } })
      } catch {}
      expect(value()).toBe(1)
      expect(frames).toEqual([0, 1])
      expect(received).toEqual([1])

      events.emit({ directory, payload: { id: "event-test", type: "server.connected", properties: {} } })
      events.emit({ directory, payload: { id: "event-test", type: "server.connected", properties: {} } })
      await Bun.sleep(30)
      expect(value()).toBe(3)
      expect(frames.at(-1)).toBe(3)
      expect(received).toEqual([1, 2, 3])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(errors.mock.calls)).not.toContain("private event contents")
    } finally {
      dispose()
      errors.mockRestore()
    }
  },
)

test("global SSE preserves durable sequence for live TUI messages", async () => {
  const received: number[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/global/event")
      return new Response("{}", { headers: { "content-type": "application/json" } })
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                directory,
                payload: {
                  id: "evt_prompted",
                  type: "session.next.prompted",
                  properties: {
                    timestamp: 53,
                    sessionID: "parent",
                    messageID: "steer",
                    prompt: { text: "continue" },
                    delivery: "steer",
                  },
                  durable: { aggregateID: "parent", seq: 53, version: 1 },
                },
              })}\n\n`,
            ),
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch
  const dispose = createRoot((dispose) => {
    createComponent(RemoteStatusProvider, {
      get children() {
        return createComponent(SDKProvider, {
          url: "http://test",
          fetch: fetcher,
          get children() {
            useSDK().event.on("event", (event) => {
              if (event.payload.type === "session.next.prompted") received.push(event.payload.durable?.seq ?? -1)
            })
            return null
          },
        })
      },
    })
    return dispose
  })

  try {
    const deadline = Date.now() + 2_500
    while (received.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(received).toEqual([53])
  } finally {
    dispose()
  }
})

test("a malformed SSE event does not terminate the global subscription", async () => {
  const received: string[] = []
  let requests = 0
  const fetcher = (async (input: RequestInfo | URL) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/global/event")
      return new Response("{}", { headers: { "content-type": "application/json" } })
    requests++
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              requests === 1
                ? 'data: {"invalid":true}\n\n'
                : 'data: {"directory":"/tmp/opencode","payload":{"id":"connected","type":"server.connected","properties":{}}}\n\n',
            ),
          )
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch
  const warnings = spyOn(console, "warn").mockImplementation(() => {})
  const dispose = createRoot((dispose) => {
    createComponent(RemoteStatusProvider, {
      get children() {
        return createComponent(SDKProvider, {
          url: "http://test",
          fetch: fetcher,
          get children() {
            useSDK().event.on("event", (event) => received.push(event.payload.type))
            return null
          },
        })
      },
    })
    return dispose
  })

  try {
    const deadline = Date.now() + 2_500
    while (!received.includes("server.connected") && Date.now() < deadline) await Bun.sleep(10)
    expect(requests).toBeGreaterThanOrEqual(2)
    expect(received).toContain("server.connected")
    expect(warnings).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
    warnings.mockRestore()
  }
})

test("an SSE stream without heartbeats is reconnected", async () => {
  const received: string[] = []
  let requests = 0
  let cancelled = false
  const fetcher = (async (input: RequestInfo | URL) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/global/event")
      return new Response("{}", { headers: { "content-type": "application/json" } })
    requests++
    return new Response(
      new ReadableStream({
        start(controller) {
          if (requests === 1) return
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"directory":"/tmp/opencode","payload":{"id":"recovered","type":"server.connected","properties":{}}}\n\n',
            ),
          )
          controller.close()
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch
  const dispose = createRoot((dispose) => {
    createComponent(RemoteStatusProvider, {
      get children() {
        return createComponent(SDKProvider, {
          url: "http://test",
          fetch: fetcher,
          sseInactivityMs: 30,
          get children() {
            useSDK().event.on("event", (event) => received.push(event.payload.type))
            return null
          },
        })
      },
    })
    return dispose
  })

  try {
    const deadline = Date.now() + 2_500
    while (!received.includes("server.connected") && Date.now() < deadline) await Bun.sleep(10)
    expect(cancelled).toBe(true)
    expect(requests).toBeGreaterThanOrEqual(2)
    expect(received).toContain("server.connected")
  } finally {
    dispose()
  }
})

test("disposing the SDK stops a stalled SSE retry", async () => {
  let requests = 0
  let cancelled = false
  const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    requests++
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch
  const dispose = createRoot((dispose) => {
    createComponent(RemoteStatusProvider, {
      get children() {
        return createComponent(SDKProvider, { url: "http://test", fetch: fetcher, sseInactivityMs: 20, children: null })
      },
    })
    return dispose
  })

  const deadline = Date.now() + 500
  while (requests === 0 && Date.now() < deadline) await Bun.sleep(10)
  expect(requests).toBe(1)
  dispose()
  await Bun.sleep(1_100)
  expect(cancelled).toBe(true)
  expect(requests).toBe(1)
})

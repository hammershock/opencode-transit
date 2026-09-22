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

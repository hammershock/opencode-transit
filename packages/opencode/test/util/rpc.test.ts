import { expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import type { rpc } from "../fixture/rpc/worker"

function connect() {
  const worker = new Worker(new URL("../fixture/rpc/worker.ts", import.meta.url).href, { preload: [] })
  const client = Rpc.client<typeof rpc>(worker)
  return {
    client,
    worker,
    [Symbol.dispose]() {
      client.dispose()
      worker.terminate()
    },
  }
}

function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

test("worker failures reject their caller without blocking concurrent or later requests", async () => {
  using fixture = connect()
  expect(await fixture.client.call("echo", "ready")).toBe("ready")
  const healthy = fixture.client.call("delayed", 50)
  expect(await failure(fixture.client.call("fail", undefined))).toMatchObject({
    name: "TypeError",
    message: "fixture failure",
  })
  expect(await failure(fixture.client.call("reject", undefined))).toMatchObject({ message: "async fixture failure" })
  expect(await failure(fixture.client.call("unserializable", undefined))).toBeInstanceOf(Error)
  expect(await healthy).toBe("finished")
  expect(await fixture.client.call("echo", "after failure")).toBe("after failure")
})

test("abort releases a waiting caller without retrying or cancelling unrelated work", async () => {
  using fixture = connect()
  expect(await fixture.client.call("echo", "ready")).toBe("ready")
  const controller = new AbortController()
  const cancelled = fixture.client.call("delayed", 100, controller.signal)
  const rejected = failure(cancelled)
  controller.abort()
  expect(await rejected).toMatchObject({ name: "AbortError" })
  expect(await failure(fixture.client.call("echo", "not sent", controller.signal))).toMatchObject({
    name: "AbortError",
  })
  // A late response must not settle a different request.
  expect(await fixture.client.call("delayed", 150)).toBe("finished")
  expect(await fixture.client.call("echo", "still usable")).toBe("still usable")
})

test("worker exit rejects every pending request and later calls", async () => {
  using fixture = connect()
  expect(await fixture.client.call("echo", "ready")).toBe("ready")
  const pending = failure(fixture.client.call("delayed", 1000))
  const stopped = failure(fixture.client.call("stop", undefined))
  for (const error of await Promise.all([pending, stopped]))
    expect(error).toMatchObject({ message: "Worker RPC closed" })
  expect(await failure(fixture.client.call("echo", "after exit"))).toMatchObject({ message: "Worker RPC closed" })
})

test("explicit disposal settles pending requests", async () => {
  using fixture = connect()
  const pending = failure(fixture.client.call("delayed", 1000))
  fixture.client.dispose()
  fixture.client.dispose()
  expect(await pending).toMatchObject({ message: "Worker RPC closed" })
  expect(await failure(fixture.client.call("echo", "after disposal"))).toMatchObject({ message: "Worker RPC closed" })
})

test("three independent workers retain their own replies after a failure", async () => {
  using first = connect()
  using second = connect()
  using third = connect()
  expect(await failure(first.client.call("fail", undefined))).toMatchObject({ message: "fixture failure" })
  expect(await Promise.all([first, second, third].map((fixture, i) => fixture.client.call("echo", String(i))))).toEqual(
    ["0", "1", "2"],
  )
})

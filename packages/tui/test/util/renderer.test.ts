import { expect, test } from "bun:test"
import { destroyRenderer, installTerminalWakeRecovery } from "../../src/util/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:"])
})

test("reinitializes the terminal once after a suspension-sized clock gap", () => {
  const calls: string[] = []
  const callbacks = new Set<() => void>()
  const cancelled: unknown[] = []
  const timer = { unref: () => calls.push("unref") } as unknown as ReturnType<typeof setInterval>
  const clock = { now: 1_000 }
  const dispose = installTerminalWakeRecovery(
    {
      isDestroyed: false,
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    },
    {
      interval: 1_000,
      threshold: 5_000,
      now: () => clock.now,
      schedule(callback, interval) {
        expect(interval).toBe(1_000)
        callbacks.add(callback)
        return timer
      },
      cancel(value) {
        cancelled.push(value)
      },
    },
  )

  clock.now = 2_100
  callbacks.forEach((callback) => callback())
  clock.now = 12_100
  callbacks.forEach((callback) => callback())
  clock.now = 13_100
  callbacks.forEach((callback) => callback())

  expect(calls).toEqual(["unref", "suspend", "resume"])
  dispose()
  dispose()
  expect(cancelled).toEqual([timer])
})

test("does not recover a destroyed renderer or run after disposal", () => {
  const calls: string[] = []
  let tick = () => {}
  let now = 0
  const renderer = {
    isDestroyed: false,
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
  }
  const dispose = installTerminalWakeRecovery(renderer, {
    threshold: 5_000,
    now: () => now,
    schedule(callback) {
      tick = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    cancel() {
      calls.push("cancel")
    },
  })

  renderer.isDestroyed = true
  now = 10_000
  tick()
  renderer.isDestroyed = false
  dispose()
  now = 20_000
  tick()

  expect(calls).toEqual(["cancel"])
})

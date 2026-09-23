import type { CliRenderer } from "@opentui/core"

type WakeRenderer = Pick<CliRenderer, "isDestroyed" | "suspend" | "resume">

type WakeRecoveryOptions = {
  interval?: number
  threshold?: number
  now?: () => number
  schedule?: (callback: () => void, interval: number) => ReturnType<typeof setInterval>
  cancel?: (timer: ReturnType<typeof setInterval>) => void
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
}

export function installTerminalWakeRecovery(renderer: WakeRenderer, options: WakeRecoveryOptions = {}) {
  const interval = options.interval ?? 1_000
  const threshold = options.threshold ?? 5_000
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? setInterval
  const cancel = options.cancel ?? clearInterval
  const state = { previous: now(), disposed: false }
  const timer = schedule(() => {
    const current = now()
    const elapsed = current - state.previous
    state.previous = current
    if (state.disposed || renderer.isDestroyed || elapsed < threshold) return
    // A system sleep can preserve the process while leaving OpenTUI's parser or terminal surface stale.
    // Its suspend/resume boundary resets input state, restores terminal modes, and requests a full repaint.
    renderer.suspend()
    if (renderer.isDestroyed) return
    renderer.resume()
  }, interval)
  timer.unref?.()
  return () => {
    if (state.disposed) return
    state.disposed = true
    cancel(timer)
  }
}

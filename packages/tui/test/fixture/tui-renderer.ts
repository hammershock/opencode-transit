import { testRender } from "@opentui/solid"
import { Flock } from "@opencode-ai/core/util/flock"
import os from "node:os"
import path from "node:path"

export async function testRenderExclusive(...input: Parameters<typeof testRender>) {
  const lease = await Flock.acquire("opentui-test-renderer", {
    dir: path.join(os.tmpdir(), "opencode-tui-test-locks"),
    staleMs: 10_000,
    timeoutMs: 20_000,
  })

  try {
    const app = await testRender(...input)
    let destroyed = false
    return {
      app,
      async destroy() {
        if (destroyed) return
        destroyed = true
        try {
          app.renderer.destroy()
          await Bun.sleep(10)
        } finally {
          await lease.release()
        }
      },
    }
  } catch (error) {
    await lease.release()
    throw error
  }
}

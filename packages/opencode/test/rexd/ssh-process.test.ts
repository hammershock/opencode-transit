import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { RexdRpcClient } from "../../src/rexd/rpc"
import { runSshScript, SshTransport } from "../../src/rexd/ssh"
import { tmpdir } from "../fixture/fixture"

test("SSH script cancellation terminates and reaps the child process", async () => {
  await using tmp = await tmpdir()
  const executable = path.join(tmp.path, "ssh-fixture")
  const ready = path.join(tmp.path, "ready")
  const closed = path.join(tmp.path, "closed")
  await Bun.write(
    executable,
    `#!/bin/sh
touch '${ready}'
trap "touch '${closed}'; exit 0" TERM INT
while :; do :; done
`,
  )
  await Bun.spawn(["chmod", "0700", executable]).exited

  const controller = new AbortController()
  const running = runSshScript({ type: "ssh-config", host: "fixture" }, "ignored", controller.signal, executable)
  await waitForFile(ready)
  controller.abort()
  await expect(running).rejects.toMatchObject({ phase: "cancelled" })
  await waitForFile(closed)
})

test("RPC timeout reaps a child process whose stdin remains blocked", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const client = new RexdRpcClient(new SshTransport(child, { type: "ssh-config", host: "fixture" }))

  await expect(
    client.request("fs.write", { content: "x".repeat(2 * 1024 * 1024) }, { timeoutMs: 20, sideEffect: true }),
  ).rejects.toMatchObject({
    message: "Rexd request timed out while writing: fs.write",
    phase: "transport",
    outcome: "unknown",
  })
  await Promise.race([
    closed,
    Bun.sleep(3_000).then(() => {
      throw new Error("Timed out waiting for the blocked transport child to exit")
    }),
  ])
})

async function waitForFile(file: string) {
  const timeout = Date.now() + 3_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > timeout) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(10)
  }
}

/** Manual, isolated Rexd acceptance. Run only with TASK_REXD_TARGET_NAME set. */
import { randomUUID } from "node:crypto"
import { Duration } from "effect"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { connectRexd } from "@/rexd/connection"
import { runRexdProcess } from "@/rexd/process-runner"

const name = process.env.TASK_REXD_TARGET_NAME
if (!name) throw new Error("TASK_REXD_TARGET_NAME is required")
const registry = TargetRegistry.make({ directory: `${process.env.HOME}/.config/opencode` })
const target = (await registry.load()).targets.find((item) => item.name === name)
if (!target) throw new Error("Configured Rexd target not found")
const directory = target.defaultDirectory
if (!directory) throw new Error("Target has no configured default directory")
const nonce = `task-567-${randomUUID()}`
const options = { cwd: directory, timeout: Duration.seconds(60), maxOutputBytes: 4096 }
const lease = await connectRexd(target, { directory, clientVersion: "task-567-acceptance" })
let pid: number | undefined
let cancelled = false
try {
  const controller = new AbortController()
  let resolvePID!: (value: number) => void
  const started = new Promise<number>((resolve) => {
    resolvePID = resolve
  })
  const running = runRexdProcess(lease, {
    ...options,
    argv: ["/bin/bash", "-c", `printf 'PID:%s\\n' "$$"; exec -a ${nonce} /bin/sleep 45`],
    shell: false,
    signal: controller.signal,
    onOutput: async ({ data }) => {
      const match = new TextDecoder().decode(data).match(/PID:(\d+)/)
      if (match) resolvePID(Number(match[1]))
    },
  })
  pid = await Promise.race([
    started,
    Bun.sleep(15_000).then(() => Promise.reject(new Error("Rexd process never started"))),
  ])
  controller.abort(new Error("task-567 exact cancellation"))
  cancelled = await running.then(
    () => false,
    () => true,
  )
  if (!cancelled) throw new Error("Rexd process returned success after cancellation")
  const check = await runRexdProcess(lease, {
    ...options,
    argv: ["/bin/bash", "-c", `ps -p ${pid} -o args= || true`],
    shell: false,
  })
  const args = check.stdout.toString().trim()
  if (args.includes(nonce)) throw new Error("Cancelled Rexd process is still live")
  process.stdout.write(JSON.stringify({ target: name, cancelled, targetProcessGone: true }) + "\n")
} finally {
  if (pid) {
    const check = await runRexdProcess(lease, {
      ...options,
      argv: ["/bin/bash", "-c", `ps -p ${pid} -o args= || true`],
      shell: false,
    }).catch(() => undefined)
    if (check?.stdout.toString().includes(nonce))
      await runRexdProcess(lease, { ...options, argv: ["/bin/kill", "-KILL", String(pid)], shell: false }).catch(
        () => undefined,
      )
  }
  await lease.close()
}

if (process.env.TASK_REXD_TEST_DISCONNECT === "1") {
  const marker = `task-567-disconnect-${randomUUID()}`
  const disconnected = await connectRexd(target, { directory, clientVersion: "task-567-acceptance" })
  let remotePID: number | undefined
  try {
    let resolvePID!: (value: number) => void
    const started = new Promise<number>((resolve) => {
      resolvePID = resolve
    })
    const running = runRexdProcess(disconnected, {
      ...options,
      argv: ["/bin/bash", "-c", `printf 'PID:%s\\n' "$$"; exec -a ${marker} /bin/sleep 45`],
      shell: false,
      onOutput: async ({ data }) => {
        const match = new TextDecoder().decode(data).match(/PID:(\d+)/)
        if (match) resolvePID(Number(match[1]))
      },
    })
    const outcome = running.then(
      () => false,
      () => true,
    )
    remotePID = await Promise.race([
      started,
      Bun.sleep(15_000).then(() => Promise.reject(new Error("Rexd disconnect process never started"))),
    ])
    await disconnected.client.close().catch(() => undefined)
    const localUnavailable = await outcome
    if (!localUnavailable) throw new Error("Rexd disconnect was incorrectly reported as completed")
    const observer = await connectRexd(target, { directory, clientVersion: "task-567-acceptance" })
    try {
      const check = await runRexdProcess(observer, {
        ...options,
        argv: ["/bin/bash", "-c", `ps -p ${remotePID} -o args= || true`],
        shell: false,
      })
      const remoteStillLive = check.stdout.toString().includes(marker)
      if (remoteStillLive)
        await runRexdProcess(observer, {
          ...options,
          argv: ["/bin/kill", "-KILL", String(remotePID)],
          shell: false,
        })
      process.stdout.write(JSON.stringify({ target: name, disconnectLocalUnavailable: true, remoteStillLive }) + "\n")
    } finally {
      await observer.close()
    }
  } finally {
    await disconnected.close()
  }
}

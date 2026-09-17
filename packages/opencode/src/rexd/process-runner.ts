import { LocationProcess } from "@opencode-ai/core/location-process"
import { AppProcess } from "@opencode-ai/core/process"
import { Duration, Result, Schema } from "effect"
import type { RexdLease } from "./connection"

const Started = Schema.Struct({ process_id: Schema.String })
const Output = Schema.Struct({
  process_id: Schema.String,
  data: Schema.String,
  encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
})
const Exited = Schema.Struct({
  process_id: Schema.String,
  exit_code: Schema.NullOr(Schema.Number),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  timed_out: Schema.optional(Schema.Boolean),
})
const EXIT_EVENT_GRACE_MS = 1_000

/**
 * Executes one bounded operation through an already-acquired Rexd lease.
 *
 * This is provider-private transport plumbing, not a public remote command API.
 * Callers must provide the exact argv or command needed by their capability.
 */
export async function runRexdProcess(
  lease: RexdLease,
  options: Omit<LocationProcess.RunOptions, "shell"> &
    ({ readonly command: string; readonly shell: true } | { readonly argv: readonly string[]; readonly shell: false }),
): Promise<AppProcess.RunResult> {
  const chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[], output: [] as Uint8Array[] }
  const bytes = { stdout: 0, stderr: 0, output: 0 }
  const truncated = { stdout: false, stderr: false, output: false }
  const description = options.shell ? options.command : options.argv.join(" ")
  let processID: string | undefined
  let resolveExit = (_value: typeof Exited.Type) => undefined as void
  let rejectExit = (_cause: Error) => undefined as void
  let outputChain = Promise.resolve()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const exited = new Promise<typeof Exited.Type>((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })
  const receive = (method: string, params: unknown) => {
    if (method === "exec.exit") {
      const decoded = Schema.decodeUnknownResult(Exited)(params)
      if (Result.isSuccess(decoded) && decoded.success.process_id === processID) resolveExit(decoded.success)
      return
    }
    if (method !== "exec.stdout" && method !== "exec.stderr") return
    const decoded = Schema.decodeUnknownResult(Output)(params)
    if (Result.isFailure(decoded) || decoded.success.process_id !== processID) return
    const chunk = Buffer.from(decoded.success.data, decoded.success.encoding ?? "utf8")
    const stream = method === "exec.stdout" ? "stdout" : "stderr"
    append(stream, chunk)
    const visible = append("output", chunk)
    if (visible.length > 0 && options.onOutput) {
      outputChain = outputChain.then(() => options.onOutput?.({ stream, data: visible }))
    }
  }
  const pending: Array<[string, unknown]> = []
  const remove = lease.client.onNotification((method, params) => {
    if (!processID) {
      pending.push([method, params])
      return
    }
    receive(method, params)
  })
  const removeClose = lease.client.onClose((error) => rejectExit(error))
  const abort = () => rejectExit(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"))
  try {
    const started = Schema.decodeUnknownSync(Started)(
      await lease.client.request(
        "exec.start",
        {
          session_id: lease.handshake.sessionID,
          ...(options.shell ? { command: options.command } : { argv: options.argv }),
          shell: options.shell,
          login: false,
          cwd: options.cwd,
          env: options.env,
          timeout_ms: Duration.toMillis(options.timeout),
          max_output_bytes: options.maxOutputBytes,
        },
        { timeoutMs: 20_000, signal: options.signal, sideEffect: true },
      ),
    )
    processID = started.process_id
    // Rexd enforces the command timeout, but its terminal notification is not
    // reliable enough to leave the controller waiting without its own bound.
    deadline = setTimeout(
      () => rejectExit(new Error("Timed out")),
      Duration.toMillis(options.timeout) + EXIT_EVENT_GRACE_MS,
    )
    pending.forEach(([method, params]) => receive(method, params))
    pending.length = 0
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    const terminal = await exited.catch(async (cause) => {
      await lease.client
        .request(
          "exec.kill",
          { session_id: lease.handshake.sessionID, process_id: processID!, signal: "KILL" },
          { timeoutMs: 5_000, sideEffect: true },
        )
        .catch(() => undefined)
      await outputChain
      throw cause
    })
    await outputChain
    return {
      command: description,
      exitCode: terminal.exit_code ?? -1,
      output: Buffer.concat(chunks.output),
      stdout: Buffer.concat(chunks.stdout),
      stderr: Buffer.concat(chunks.stderr),
      outputTruncated: truncated.output,
      stdoutTruncated: truncated.stdout,
      stderrTruncated: truncated.stderr,
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    remove()
    removeClose()
    options.signal?.removeEventListener("abort", abort)
  }

  function append(stream: keyof typeof chunks, chunk: Uint8Array) {
    const remaining = options.maxOutputBytes - bytes[stream]
    const retained = remaining > 0 ? chunk.slice(0, remaining) : chunk.slice(0, 0)
    if (retained.length > 0) chunks[stream].push(retained)
    bytes[stream] += chunk.length
    truncated[stream] ||= chunk.length > remaining
    return retained
  }
}

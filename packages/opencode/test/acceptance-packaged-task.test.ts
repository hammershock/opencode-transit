import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestLLMServer, reply } from "./lib/llm-server"
import { tmpdir } from "./fixture/fixture"
import net from "node:net"
import { Database } from "bun:sqlite"
import { Terminal } from "@xterm/headless"

const binary = process.env.OPENCODE_PACKAGED_BINARY
const packagedTest = binary ? test : test.skip

const waitFor = async <T>(read: () => Promise<T | undefined>, label: string, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

packagedTest("packaged Task controls steer active children and interrupt a running shell", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* Effect.promise(async () => {
      await using temp = await tmpdir({ git: true })
      await using runtime = await tmpdir()
      const lease = net.createServer()
      await new Promise<void>((resolve) => lease.listen(0, "127.0.0.1", resolve))
      const address = lease.address()
      if (!address || typeof address === "string") throw new Error("No test TCP port")
      const port = address.port
      await new Promise<void>((resolve) => lease.close(() => resolve()))
      const config = {
        experimental: { background_subagents: true },
        providers: {
          test: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
            request: { body: { apiKey: "test-key" } },
            models: { "test-model": { api: { id: "test-model" } } },
          },
        },
      }
      await Bun.write(`${temp.path}/opencode.jsonc`, JSON.stringify(config))
      const releases = Array.from({ length: 6 }, () => {
        let release!: () => void
        const waiting = new Promise<void>((resolve) => { release = resolve })
        return { waiting, release }
      })
      let releaseParent!: () => void
      const parentWaiting = new Promise<void>((resolve) => { releaseParent = resolve })
      for (let index = 1; index <= 6; index++) {
        const parent = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("PARENT_SIX_MARKER")
        const args = { description: `packaged task ${index}`, prompt: `CHILD_${index}_MARKER`, subagent_type: "general", background: true }
        const response = index === 4 ? reply().wait(parentWaiting).tool("task", args).item() : reply().tool("task", args).item()
        if (response.type !== "sse") throw new Error("Expected scripted SSE Task response")
        await Effect.runPromise(llm.pushMatch(parent, {
          ...response,
          tail: response.tail.map((part) => JSON.parse(JSON.stringify(part).replaceAll("call_1", `call_task_${index}`))),
        }))
        const child = (hit: { body: Record<string, unknown> }) => {
          const text = JSON.stringify(hit.body)
          return text.includes(`CHILD_${index}_MARKER`) && !text.includes("PARENT_SIX_MARKER")
        }
        if (index === 2) {
          await Effect.runPromise(llm.toolMatch(child, "bash", {
            command: "echo $$ > interrupt-pid; sleep 60 & echo $! > interrupt-child-pid; echo started > interrupt-started; wait; echo finished > interrupt-finished",
            workdir: temp.path,
          }))
        }
        if (index === 1 || index === 3) {
          await Effect.runPromise(llm.pushMatch(child, reply().wait(releases[index - 1]!.waiting).text(`child ${index} done`).stop().item()))
          await Effect.runPromise(llm.textMatch(child, `child ${index} steer consumed`))
        } else {
          await Effect.runPromise(llm.pushMatch(child, reply().wait(releases[index - 1]!.waiting).text(`child ${index} done`).stop().item()))
        }
      }
      await Effect.runPromise(llm.textMatch((hit) => JSON.stringify(hit.body).includes("PARENT_SIX_MARKER"), "six Task calls admitted"))
      const child = Bun.spawn([binary!, "serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure"], {
        cwd: temp.path,
        env: {
          ...process.env,
          OPENCODE_TEST_HOME: runtime.path,
          XDG_CONFIG_HOME: `${runtime.path}/.config`,
          XDG_CACHE_HOME: `${runtime.path}/.cache`,
          XDG_DATA_HOME: `${runtime.path}/.local/share`,
          XDG_STATE_HOME: `${runtime.path}/.local/state`,
          OPENCODE_DB: `${runtime.path}/packaged.sqlite`,
          OPENCODE_PURE: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      // Drain logs while the server runs so pipe backpressure cannot stall it.
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const base = `http://127.0.0.1:${port}`
      const request = async (path: string, body: unknown) => {
        const response = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": temp.path },
          body: JSON.stringify(body),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
        return result as { data: unknown }
      }
      try {
        await waitFor(async () => {
          try { return (await fetch(base + "/global/health")).ok ? true : undefined } catch { return undefined }
        }, "packaged server ready")
        const created = await request("/api/session", {
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          approvalMode: "auto",
          location: { directory: temp.path },
        }) as { data: { id: string } }
        const parent = created.data.id
        const submittedAt = Date.now()
        const admitted = await request(`/api/session/${parent}/prompt`, { prompt: { text: "PARENT_SIX_MARKER" } })
        const admissionReceiptAt = Date.now()
        expect(admitted.data).toBeDefined()
        const status = async () => (await request(`/api/session/${parent}/task/status`, { limit: 16 })) as {
          data: Array<{ description: string; target: { task_id: string }; input_id?: string; active_invocation?: { parent_session_id: string; parent_message_id: string; call_id: string }; lifecycle: string }>
        }
        const active = await waitFor(async () => {
          const rows = (await status()).data
          const one = rows.find((row) => row.description === "packaged task 1")
          const three = rows.find((row) => row.description === "packaged task 3")
          return one?.lifecycle === "active" && three?.lifecycle === "active" && one.input_id && three.input_id && one.active_invocation && three.active_invocation ? { rows, one, three } : undefined
        }, "Task 1/3 active")
        const sendTimes: Array<{ index: number; start: number; end: number }> = []
        for (const [index, row] of [[1, active.one], [3, active.three]] as const) {
          const start = Date.now()
          const receipt = await request(`/api/session/${parent}/task/send`, {
            target: { task_id: row.target.task_id, input_id: row.input_id, invocation: row.active_invocation },
            operation_id: `packaged-steer-${index}`,
            text: `steer ${index}`,
          }) as unknown as { input_id: string; state: string }
          sendTimes.push({ index, start, end: Date.now() })
          expect(receipt.state).toBe("admitted")
        }
        releaseParent()
        const six = await waitFor(async () => {
          const rows = (await status()).data
          return rows.length === 6 ? rows : undefined
        }, "six Task invocations", 300)
        expect(six.map((row) => row.description).toSorted()).toEqual(Array.from({ length: 6 }, (_, index) => `packaged task ${index + 1}`))
        const database = new Database(`${runtime.path}/packaged.sqlite`, { readonly: true })
        const calls = database.query("SELECT description, call_id, parent_message_id, time_created FROM session_task WHERE parent_session_id = ? ORDER BY time_created, input_id").all(parent) as Array<{ description: string; call_id: string; parent_message_id: string; time_created: number }>
        expect(calls).toHaveLength(6)
        expect(new Set(calls.map((row) => row.call_id)).size).toBe(6)
        const parentInput = database.query("SELECT time_created, admitted_seq, promoted_seq FROM session_input WHERE id = ?").get((admitted.data as { id: string }).id) as { time_created: number; admitted_seq: number; promoted_seq: number }
        expect(parentInput.time_created).toBeGreaterThanOrEqual(submittedAt)
        expect(parentInput.time_created).toBeLessThanOrEqual(admissionReceiptAt)
        expect(parentInput.promoted_seq).toBeGreaterThan(parentInput.admitted_seq)
        expect(calls.every((row) => row.time_created >= parentInput.time_created)).toBe(true)
        const turnSettled = async (id: string) => {
          const response = await fetch(base + `/api/session/${parent}/history?limit=100`, { headers: { "x-opencode-directory": temp.path } })
          const body = await response.json() as { data: Array<{ type: string; data: { messageID?: string } }> }
          return body.data.some((event) => event.type === "session.next.turn.settled" && event.data.messageID === id) ? true : undefined
        }
        const firstPrompt = admitted.data as { id: string }
        await waitFor(() => turnSettled(firstPrompt.id), "six-call parent turn settled", 300)
        for (const letter of ["B", "C"] as const) {
          const marker = `PARENT_FOLLOW_${letter}`
          const parentMatch = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes(marker)
          const response = reply().tool("task", {
            description: `queued follow-up ${letter}`,
            prompt: `FOLLOW_${letter}_MARKER`,
            subagent_type: "general",
            task_id: active.three.target.task_id,
            background: true,
          }).item()
          await Effect.runPromise(llm.pushMatch(parentMatch, JSON.parse(JSON.stringify(response).replaceAll("call_1", `call_follow_${letter}`))))
          await Effect.runPromise(llm.textMatch(parentMatch, `follow-up ${letter} queued`))
          const input = await request(`/api/session/${parent}/prompt`, { prompt: { text: marker } }) as { data: { id: string } }
          await waitFor(() => turnSettled(input.data.id), `follow-up ${letter} parent turn`, 300)
        }
        const queued = database.query("SELECT description, state, time_created, input_id FROM session_task WHERE child_session_id = ? ORDER BY time_created, input_id").all(active.three.target.task_id) as Array<{ description: string; state: string; time_created: number; input_id: string }>
        expect(queued.map((row) => row.description)).toEqual(["packaged task 3", "queued follow-up B", "queued follow-up C"])
        expect(queued.slice(1).map((row) => row.state)).toEqual(["queued", "queued"])
        const inbox = database.query("SELECT id, admitted_seq, promoted_seq FROM session_input WHERE id IN (?, ?)").all(queued[1]!.input_id, queued[2]!.input_id) as Array<{ id: string; admitted_seq: number; promoted_seq: number | null }>
        expect(inbox.find((row) => row.id === queued[1]!.input_id)!.admitted_seq).toBeLessThan(inbox.find((row) => row.id === queued[2]!.input_id)!.admitted_seq)
        if (process.env.OPENCODE_CAPTURE_TUI === "1") {
          let output = ""
          const columns = Number(process.env.OPENCODE_TUI_COLUMNS ?? "96")
          const visible = async () => {
            const screen = new Terminal({ cols: columns, rows: 30, allowProposedApi: true })
            await new Promise<void>((resolve) => screen.write(output, resolve))
            return Array.from({ length: 30 }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n")
          }
          const terminal = new Bun.Terminal({
            cols: columns,
            rows: 30,
            data(_terminal, data) { output += new TextDecoder().decode(data) },
          })
          const tui = Bun.spawn([binary!, "attach", base, "--dir", temp.path, "--session", parent], {
            cwd: temp.path,
            env: {
              ...process.env,
              OPENCODE_TEST_HOME: runtime.path,
              XDG_CONFIG_HOME: `${runtime.path}/.config`,
              XDG_DATA_HOME: `${runtime.path}/.local/share`,
              XDG_STATE_HOME: `${runtime.path}/.local/state`,
              XDG_CACHE_HOME: `${runtime.path}/.cache`,
              OPENCODE_PURE: "1",
            },
            terminal,
            stderr: "pipe",
          })
          try {
            await waitFor(async () => output.includes("queued follow-up C") ? true : undefined, "TUI attached parent", 150)
            terminal.write("\x10")
            await Bun.sleep(100)
            terminal.write("Tasks")
            await Bun.sleep(100)
            terminal.write("\r")
            await waitFor(async () => output.includes("Background Tasks") ? true : undefined, "TUI Tasks dialog", 150)
            await Bun.sleep(150)
            expect(await visible()).toContain("2 queued · packaged task 3")
            await Bun.write(`/tmp/opencode-pr-598-tasks-${columns}.ansi`, output)
            terminal.write("\r")
            await waitFor(async () => output.includes("Location ") ? true : undefined, "TUI Task detail", 150)
            expect(await visible()).toContain("Root capacity 6/8 active, 2/64 pending")
            await Bun.write(`/tmp/opencode-pr-598-task-detail-${columns}.ansi`, output)
            terminal.write("\x1b")
            await Bun.sleep(100)
            terminal.write("\x1b")
            await Bun.sleep(100)
            terminal.write("\x10")
            await Bun.sleep(100)
            terminal.write("Tasks")
            await Bun.sleep(100)
            terminal.write("\r")
            await waitFor(async () => output.match(/Background Tasks/g)?.length && output.match(/Background Tasks/g)!.length >= 2 ? true : undefined, "TUI Tasks reopened", 150)
            await Bun.write(`/tmp/opencode-pr-598-tasks-reopened-${columns}.ansi`, output)
          } finally {
            terminal.write("\x03")
            await Promise.race([tui.exited, Bun.sleep(1_000).then(() => tui.kill())])
            terminal.close()
          }
        }
        await waitFor(async () => (await Bun.file(`${temp.path}/interrupt-started`).exists()) ? true : undefined, "long shell started")
        const blocked = six.find((row) => row.description === "packaged task 2")!
        const interruptStarted = Date.now()
        const interrupted = await request(`/api/session/${parent}/task/interrupt`, {
          target: { task_id: blocked.target.task_id, input_id: blocked.input_id, invocation: blocked.active_invocation },
        })
        expect((interrupted as unknown as { state: string }).state).toBe("requested")
        const cancelled = await waitFor(async () => {
          const row = database.query("SELECT outcome FROM session_task WHERE input_id = ?").get(blocked.input_id!) as { outcome: string } | null
          return row?.outcome === "cancelled" ? row : undefined
        }, "blocked shell invocation cancelled", 100)
        expect(cancelled.outcome).toBe("cancelled")
        const shellPID = Number(await Bun.file(`${temp.path}/interrupt-pid`).text())
        const childPID = Number(await Bun.file(`${temp.path}/interrupt-child-pid`).text())
        expect(() => process.kill(shellPID, 0)).toThrow()
        expect(() => process.kill(childPID, 0)).toThrow()
        expect(Date.now() - interruptStarted).toBeLessThan(10000)
        expect(await Bun.file(`${temp.path}/interrupt-finished`).exists()).toBe(false)
        process.stdout.write(`PACKAGED_INTERRUPT:${JSON.stringify({ receipt: interrupted, elapsedMs: Date.now() - interruptStarted, outcome: cancelled.outcome })}\n`)
        releases.forEach((item) => item.release())
        const promoted = await waitFor(async () => {
          const steers = database.query("SELECT operation_id, state, time_created, time_promoted FROM session_task_steer WHERE operation_id IN ('packaged-steer-1', 'packaged-steer-3') ORDER BY operation_id").all() as Array<{ operation_id: string; state: string; time_created: number; time_promoted: number | null }>
          return steers.length === 2 && steers.every((row) => row.state === "promoted") ? steers : undefined
        }, "two promoted steers", 600)
        expect(promoted.every((row) => row.time_promoted !== null && row.time_promoted >= row.time_created)).toBe(true)
        expect(promoted.every((row) => {
          const index = Number(row.operation_id.slice(-1))
          const sent = sendTimes.find((item) => item.index === index)!
          return row.time_created >= sent.start && row.time_created <= sent.end
        })).toBe(true)
        const hits = await waitFor(async () => {
          const current = await Effect.runPromise(llm.hits)
          return current.some((hit) => JSON.stringify(hit.body).includes("steer 1")) && current.some((hit) => JSON.stringify(hit.body).includes("steer 3")) ? current : undefined
        }, "both child providers see promoted steer", 200)
        expect(hits.some((hit) => JSON.stringify(hit.body).includes("steer 1"))).toBe(true)
        expect(hits.some((hit) => JSON.stringify(hit.body).includes("steer 3"))).toBe(true)
        expect(promoted.every((row) => hits.some((hit) =>
          JSON.stringify(hit.body).includes(`steer ${row.operation_id.slice(-1)}`) && hit.observedAt >= row.time_promoted!,
        ))).toBe(true)
        const promotedFollowups = await waitFor(async () => {
          const rows = database.query("SELECT id, admitted_seq, promoted_seq FROM session_input WHERE id IN (?, ?)").all(queued[1]!.input_id, queued[2]!.input_id) as Array<{ id: string; admitted_seq: number; promoted_seq: number | null }>
          return rows.length === 2 && rows.every((row) => row.promoted_seq !== null) ? rows : undefined
        }, "both queued follow-ups promoted", 300)
        expect(promotedFollowups.find((row) => row.id === queued[1]!.input_id)!.promoted_seq!).toBeLessThan(promotedFollowups.find((row) => row.id === queued[2]!.input_id)!.promoted_seq!)
        const allSettled = await waitFor(async () => {
          const rows = database.query("SELECT state FROM session_task WHERE parent_session_id = ?").all(parent) as Array<{ state: string }>
          return rows.length === 8 && rows.every((row) => row.state === "settled") ? rows : undefined
        }, "six Task calls and two queued follow-ups settled", 300)
        expect(allSettled).toHaveLength(8)
        process.stdout.write(`PACKAGED_SIX:${JSON.stringify({ callCount: calls.length, distinctCallIDs: new Set(calls.map((row) => row.call_id)).size, steerStates: promoted.map((row) => row.state), queuedOrder: queued.slice(1).map((row) => row.description) })}\n`)
        database.close()
      } finally {
        releases.forEach((item) => item.release())
        releaseParent()
        child.kill("SIGKILL")
        await child.exited
        await Promise.all([stdout, stderr])
      }
    })
  }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped))
}, 120_000)

import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Terminal } from "@xterm/headless"
import { Effect } from "effect"
import net from "node:net"
import { tmpdir } from "./fixture/fixture"
import { TestLLMServer, reply } from "./lib/llm-server"

const binary = process.env.OPENCODE_PACKAGED_BINARY

test.skipIf(!binary)("packaged TUI keeps a background Task inspectable and the parent transcript current", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      return yield* Effect.promise(async () => {
        await using project = await tmpdir({ git: true })
        await using runtime = await tmpdir()
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
        await Bun.write(`${project.path}/opencode.jsonc`, JSON.stringify(config))
        const parent = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("TUI_PARENT_START")
        const child = (hit: { body: Record<string, unknown> }) => {
          const body = JSON.stringify(hit.body)
          return body.includes("TUI_CHILD_WORK") && !body.includes("TUI_PARENT_START")
        }
        await Effect.runPromise(llm.toolMatch(parent, "task", {
          description: "inspect live child",
          prompt: "TUI_CHILD_WORK",
          subagent_type: "general",
          background: true,
        }))
        await Effect.runPromise(llm.textMatch(parent, "Parent acknowledged background work"))
        let releaseChild!: () => void
        const childWaiting = new Promise<void>((resolve) => { releaseChild = resolve })
        await Effect.runPromise(llm.pushMatch(child, reply().wait(childWaiting).text("Child finished safely").stop().item()))
        await Effect.runPromise(llm.textMatch((hit) => JSON.stringify(hit.body).includes("TUI_USER_AFTER_TASK"), "Parent answered follow-up"))

        const lease = net.createServer()
        await new Promise<void>((resolve) => lease.listen(0, "127.0.0.1", resolve))
        const address = lease.address()
        if (!address || typeof address === "string") throw new Error("No test TCP port")
        await new Promise<void>((resolve) => lease.close(() => resolve()))
        const base = `http://127.0.0.1:${address.port}`
        const environment = {
          ...process.env,
          HOME: runtime.path,
          OPENCODE_TEST_HOME: runtime.path,
          XDG_CONFIG_HOME: `${runtime.path}/.config`,
          XDG_CACHE_HOME: `${runtime.path}/.cache`,
          XDG_DATA_HOME: `${runtime.path}/.local/share`,
          XDG_STATE_HOME: `${runtime.path}/.local/state`,
          OPENCODE_DB: `${runtime.path}/opencode.sqlite`,
          OPENCODE_PURE: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_AUTH_CONTENT: "{}",
        }
        const server = Bun.spawn([binary!, "serve", "--port", String(address.port), "--hostname", "127.0.0.1", "--pure"], {
          cwd: project.path,
          env: environment,
          stdout: "pipe",
          stderr: "pipe",
        })
        const stdout = new Response(server.stdout).text()
        const stderr = new Response(server.stderr).text()
        const request = async (path: string, body: unknown) => {
          const response = await fetch(base + path, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": project.path },
            body: JSON.stringify(body),
          })
          const result = await response.json() as { data: unknown }
          if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
          return result.data
        }
        const waitFor = async <T,>(read: () => Promise<T | undefined>, label: string) => {
          for (let attempt = 0; attempt < 150; attempt++) {
            const value = await read()
            if (value !== undefined) return value
            await Bun.sleep(100)
          }
          throw new Error(`Timed out waiting for ${label}`)
        }
        try {
          await waitFor(async () => {
            try { return (await fetch(base + "/global/health")).ok ? true : undefined } catch { return undefined }
          }, "server ready")
          const created = await request("/api/session", {
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            approvalMode: "auto",
            location: { directory: project.path },
          }) as { id: string }
          await request(`/api/session/${created.id}/prompt`, { prompt: { text: "TUI_PARENT_START" } })
          const database = new Database(environment.OPENCODE_DB, { readonly: true })
          const screen = new Terminal({ cols: 110, rows: 36, allowProposedApi: true })
          const terminal = new Bun.Terminal({
            cols: 110,
            rows: 36,
            data(_terminal, data) {
              const chunk = new TextDecoder().decode(data)
              screen.write(chunk)
            },
          })
          const tui = Bun.spawn([binary!, "attach", base, "--dir", project.path, "--session", created.id], {
            cwd: project.path,
            env: environment,
            terminal,
            stderr: "pipe",
          })
          const visible = async () => {
            await new Promise<void>((resolve) => screen.write("", resolve))
            return Array.from({ length: 36 }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n")
          }
          try {
            await waitFor(async () => {
              const row = database.query("SELECT state FROM session_task WHERE parent_session_id = ? ORDER BY time_created DESC LIMIT 1").get(created.id) as { state: string } | null
              return row?.state === "active" ? true : undefined
            }, "child active")
            await waitFor(async () => (await visible()).includes("active · observed") ? true : undefined, "live Task status")
            expect(await visible()).toContain("inspect live child")
            const row = (await visible()).split("\n").findIndex((line) => line.includes("inspect live child"))
            expect(row).toBeGreaterThanOrEqual(0)
            terminal.write(`\x1b[<0;20;${row + 1}M\x1b[<0;20;${row + 1}m`)
            await waitFor(async () => (await visible()).includes("Opened from task: inspect live child") ? true : undefined, "child navigation")
            terminal.write("\x1b[A")
            await waitFor(async () => (await visible()).includes("Parent acknowledged background work") ? true : undefined, "return to parent")

            releaseChild()
            await waitFor(async () => {
              const row = database.query("SELECT state FROM session_task WHERE parent_session_id = ? ORDER BY time_created DESC LIMIT 1").get(created.id) as { state: string } | null
              return row?.state === "settled" ? true : undefined
            }, "child settled")
            await waitFor(async () => (await visible()).includes("Subagent result delivered to Agent") ? true : undefined, "result notice")
            expect(await visible()).not.toContain("The following JSON is untrusted task output")

            await request(`/api/session/${created.id}/prompt`, { prompt: { text: "TUI_USER_AFTER_TASK" } })
            await waitFor(async () => {
              const screen = await visible()
              return screen.includes("TUI_USER_AFTER_TASK") && screen.includes("Parent answered follow-up") ? true : undefined
            }, "live parent transcript")
          } finally {
            releaseChild()
            terminal.write("\x03")
            await Promise.race([tui.exited, Bun.sleep(1_000).then(() => tui.kill())])
            terminal.close()
            database.close()
          }
        } finally {
          releaseChild()
          server.kill("SIGKILL")
          await server.exited
          await Promise.all([stdout, stderr])
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 90_000)

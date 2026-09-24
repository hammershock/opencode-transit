import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { tmpdir } from "./fixture/fixture"
import { TestLLMServer } from "./lib/llm-server"

const binary = process.env.OPENCODE_PACKAGED_BINARY

test.skipIf(!binary)("packaged default handler executes a V2 Task without legacy admission", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PACKAGED_PARENT_MARKER"),
        "task",
        { description: "inspect child", prompt: "PACKAGED_CHILD_MARKER", subagent_type: "general" },
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("PACKAGED_CHILD_MARKER"), "child completed")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("PACKAGED_PARENT_MARKER"), "parent completed")
      return yield* Effect.promise(async () => {
        await using project = await tmpdir({ git: true })
        await using runtime = await tmpdir()
        const databasePath = `${runtime.path}/opencode.sqlite`
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
        const child = Bun.spawn(
          [binary!, "run", "--model", "test/test-model", "--agent", "build", "--auto", "PACKAGED_PARENT_MARKER"],
          {
            cwd: project.path,
            env: {
              ...process.env,
              HOME: runtime.path,
              OPENCODE_TEST_HOME: runtime.path,
              XDG_CONFIG_HOME: `${runtime.path}/.config`,
              XDG_CACHE_HOME: `${runtime.path}/.cache`,
              XDG_DATA_HOME: `${runtime.path}/.local/share`,
              XDG_STATE_HOME: `${runtime.path}/.local/state`,
              OPENCODE_DB: databasePath,
              OPENCODE_PURE: "1",
              OPENCODE_DISABLE_AUTOUPDATE: "1",
              OPENCODE_DISABLE_AUTOCOMPACT: "1",
              OPENCODE_DISABLE_MODELS_FETCH: "1",
              OPENCODE_AUTH_CONTENT: "{}",
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        try {
          const [stdout, stderr, code] = await Promise.race([
            Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
            Bun.sleep(45_000).then(() => {
              throw new Error("packaged Task run timed out")
            }),
          ])
          if (code !== 0) {
            const failure = new Database(databasePath, { readonly: true })
            const messages = failure.query("SELECT type, data FROM session_message ORDER BY seq").all()
            failure.close()
            throw new Error(`Packaged Task failed: ${stdout.slice(-2_000)}\n${stderr.slice(-2_000)}\n${JSON.stringify(messages)}`)
          }
          expect(stdout).toContain("parent completed")
          const hits = await Effect.runPromise(llm.hits)
          expect(hits.some((hit) => JSON.stringify(hit.body).includes("PACKAGED_CHILD_MARKER"))).toBe(true)
          expect(JSON.stringify(hits[0]?.body)).toContain('"name":"task_status"')
          const database = new Database(databasePath, { readonly: true })
          try {
            const rows = database.query("SELECT backend, state, time_started FROM session_task").all() as Array<{
              backend: string
              state: string
              time_started: number | null
            }>
            expect(rows).toHaveLength(1)
            expect(rows[0]?.backend).toBe("v2")
            expect(rows[0]?.state).toBe("settled")
            expect(rows[0]?.time_started).not.toBeNull()
          } finally {
            database.close()
          }
        } finally {
          child.kill()
          await child.exited
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

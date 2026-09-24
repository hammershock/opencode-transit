import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestLLMServer } from "./lib/llm-server"
import { testProviderConfig } from "./lib/test-provider"
import { tmpdir } from "./fixture/fixture"

const binary = process.env.OPENCODE_PACKAGED_BINARY

test.skipIf(!binary)(
  "packaged primary Agent lists targets without the Environment experiment",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.tool("slash_command", { command: "/target list" })
        yield* llm.text("Target list received")
        return yield* Effect.promise(async () => {
          await using project = await tmpdir({ git: true })
          await using runtime = await tmpdir()
          const child = Bun.spawn(
            [binary!, "run", "--model", "test/test-model", "--agent", "build", "--auto", "TARGET_LIST_MARKER"],
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
                OPENCODE_DB: `${runtime.path}/opencode.sqlite`,
                OPENCODE_PURE: "1",
                OPENCODE_DISABLE_PROJECT_CONFIG: "1",
                OPENCODE_DISABLE_AUTOUPDATE: "1",
                OPENCODE_DISABLE_AUTOCOMPACT: "1",
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                OPENCODE_AUTH_CONTENT: "{}",
                OPENCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          try {
            const completed = await Promise.race([
              Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
              Bun.sleep(30_000).then(() => {
                throw new Error("packaged Agent run timed out")
              }),
            ])
            expect(completed[2], completed[1].slice(-2_000)).toBe(0)
            const hits = await Effect.runPromise(llm.hits)
            const results = hits.flatMap((hit) =>
              Array.isArray(hit.body.messages)
                ? (hit.body.messages as unknown[]).flatMap((message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "tool" &&
                    "content" in message
                      ? [String(message.content)]
                      : [],
                  )
                : [],
            )
            expect(results.some((result) => result.includes("Local execution target"))).toBe(true)
            expect(results.join("\n")).not.toContain("Environment service is unavailable")
          } finally {
            child.kill()
            await child.exited
          }
        })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
    )
  },
  45_000,
)

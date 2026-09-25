import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { tmpdir } from "../fixture/fixture"

test.each([
  { legacy: false, empty: false },
  { legacy: true, empty: false },
  { legacy: false, empty: true },
  { legacy: true, empty: true },
])(
  "production V2 manual compaction through legacy HTTP route: %p",
  async ({ legacy, empty }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const temp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )
        if (!empty) {
          yield* llm.text("Initial answer")
          yield* llm.text("## Objective\n- Keep working")
        }
        const child = Bun.spawn([process.execPath, "test/fixture/manual-compact-process.ts"], {
          cwd: import.meta.dir + "/../..",
          env: {
            ...process.env,
            OPENCODE_DB: `${temp.path}/manual-compact.sqlite`,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)),
            MANUAL_COMPACT_TEST_DIRECTORY: temp.path,
            MANUAL_COMPACT_TEST_LLM_URL: llm.url,
            MANUAL_COMPACT_TEST_LEGACY: String(legacy),
            MANUAL_COMPACT_TEST_EMPTY: String(empty),
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = yield* Effect.promise(() =>
          Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        )
        expect(code, stderr.slice(0, 4_096)).toBe(0)
        const line = stdout.split("\n").find((item) => item.startsWith("MANUAL_COMPACT_RESULT:"))
        expect(line).toBeDefined()
        const result = JSON.parse(line!.slice("MANUAL_COMPACT_RESULT:".length)) as {
          status: number
          body: string
          context: Array<{ type: string; summary?: string; reason?: string }>
          legacyMessages: number
          model: { id: string; providerID: string }
        }
        expect(result.status, result.body).toBe(empty ? 400 : legacy ? 200 : 204)
        expect(result.legacyMessages).toBe(0)
        expect(result.model).toMatchObject({ providerID: "test", id: "test-model" })
        if (empty) {
          expect(result.context).toHaveLength(0)
          expect(JSON.parse(result.body)).toMatchObject({ kind: "session_compaction_empty" })
          expect(yield* llm.hits).toHaveLength(0)
          return
        }
        expect(result.context[0]).toMatchObject({
          type: "compaction",
          reason: "manual",
          summary: "## Objective\n- Keep working",
        })
        expect(
          (yield* llm.hits).filter((hit) => JSON.stringify(hit.body).includes("Here is the conversation so far")),
        ).toHaveLength(1)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
    )
  },
  60_000,
)

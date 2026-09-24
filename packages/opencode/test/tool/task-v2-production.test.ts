import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { tmpdir } from "../fixture/fixture"

test("production V2 parent advertises and executes Task through a provider tool call", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PARENT_TASK_MARKER"),
        "task",
        { description: "inspect cache", prompt: "CHILD_TASK_MARKER", subagent_type: "general", background: true },
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"), "child complete")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("PARENT_TASK_MARKER"), "parent continues")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/task-v2-parent.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { background_subagents: true },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      const hits = yield* llm.hits
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      const line = stdout.split("\n").find((item) => item.startsWith("TASK_V2_PARENT_RESULT:"))
      expect(line).toBeDefined()
      const result = JSON.parse(line!.slice("TASK_V2_PARENT_RESULT:".length)) as {
        rows: Array<{ backend: string; state: string }>
        legacyMessages: number
      }
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.backend).toBe("v2")
      expect(result.legacyMessages).toBe(0)
      const definitions = JSON.stringify(hits[0]?.body)
      for (const name of [
        "task",
        "task_status",
        "task_send",
        "task_reconcile",
        "task_wait",
        "task_interrupt",
        "task_stop",
      ])
        expect(definitions).toContain(`"name":"${name}"`)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

test("production V2 parent invokes task_status and receives the bounded direct-child receipt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PARENT_STATUS_MARKER"),
        "task_status",
        {},
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('"name":"task_status"'), "status checked")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/task-v2-status.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { background_subagents: true },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_CONTROL: "status",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      expect(stdout).toContain("TASK_V2_PARENT_RESULT:")
      const hits = yield* llm.hits
      expect(hits.length, stdout + stderr.slice(0, 4_096)).toBeGreaterThanOrEqual(2)
      const request = hits[1]?.body as { messages?: Array<{ role: string; content?: string }> }
      const result = request.messages?.find((message) => message.role === "tool")
      expect(result?.content && JSON.parse(result.content)).toEqual({ data: [] })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

test("HTTP V2 prompt reaches the real provider with Task controls in a fresh Session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => Bun.write(`${temp.path}/opencode.jsonc`, JSON.stringify({
        experimental: { background_subagents: true },
        providers: {
          test: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
            request: { body: { apiKey: "test-key" } },
            models: { "test-model": { api: { id: "test-model" } } },
          },
        },
      })))
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PARENT_STATUS_MARKER"),
        "task_status",
        {},
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('"name":"task_status"'), "status checked")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/task-v2-http.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { background_subagents: true },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_CONTROL: "status",
          TASK_V2_TEST_HTTP: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      expect(stdout).toContain("TASK_V2_PARENT_RESULT:")
      const hits = yield* llm.hits
      expect(hits.length, stdout + stderr.slice(0, 4_096)).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(hits[0]?.body)).toContain('"name":"task_status"')
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

test("production V2 parent omits Task control advertisements when the experiment is disabled", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("PARENT_STATUS_MARKER"), "status disabled")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/task-v2-disabled.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { background_subagents: false },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_CONTROL: "status",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      expect(stdout).toContain("TASK_V2_PARENT_RESULT:")
      const hits = yield* llm.hits
      const definitions = JSON.stringify(hits[0]?.body)
      for (const name of ["task_status", "task_send", "task_reconcile", "task_wait", "task_interrupt", "task_stop"])
        expect(definitions).not.toContain(`"name":"${name}"`)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

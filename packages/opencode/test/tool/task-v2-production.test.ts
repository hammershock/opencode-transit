import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { tmpdir } from "../fixture/fixture"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("production HTTP command runs a configured V2 subtask through the durable Task adapter", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Inspect cache"), "child complete")
      yield* llm.text("parent complete")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/command-v2.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            command: { inspect: { template: "Inspect $ARGUMENTS", agent: "general", model: "test/test-model", subtask: true } },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_HTTP: "true",
          TASK_V2_TEST_COMMAND: "true",
          TASK_V2_TEST_SETTLE: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      const line = stdout.split("\n").find((item) => item.startsWith("TASK_V2_PARENT_RESULT:"))
      expect(line).toBeDefined()
      const result = JSON.parse(line!.slice("TASK_V2_PARENT_RESULT:".length)) as {
        rows: Array<{ backend: string; state: string; outcome?: string }>
        legacyMessages: number
      }
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ backend: "v2", state: "settled", outcome: "completed" })
      expect(result.legacyMessages).toBe(0)
      expect((yield* llm.hits).some((hit) => JSON.stringify(hit.body).includes("Inspect cache"))).toBe(true)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

test.each([false, true])("production V2 parent executes Task with default HTTP handler first: %p", async (handlerFirst) => {
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
          TASK_V2_TEST_DEFAULT_HANDLER_FIRST: String(handlerFirst),
          TASK_V2_TEST_SETTLE: "true",
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
        parent: string
        rows: Array<{ backend: string; state: string; child: string }>
        legacyMessages: number
        contextParts: Array<{ key: string; text: string }>
      }
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.backend).toBe("v2")
      expect(result.rows[0]?.state).toBe("settled")
      expect(result.legacyMessages).toBe(0)
      expect(hits.some((hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"))).toBe(true)
      const definitions = JSON.stringify(hits[0]?.body)
      expect(definitions).toContain('"name":"slash_command"')
      expect(JSON.stringify(hits.find((hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"))?.body)).not.toContain(
        '"name":"slash_command"',
      )
      expect(definitions).toContain("<available-subagents>")
      expect(definitions).toContain("task_wait_target")
      expect(definitions).toContain("120000")
      expect(result.contextParts.find((part) => part.key === "subagents")?.text).toContain("<available-subagents>")
      expect(result.contextParts.find((part) => part.key === "available-targets")?.text).toContain("<available-targets>")
      const toolResult = hits.flatMap((hit) =>
        Array.isArray(hit.body.messages)
          ? (hit.body.messages as Array<{ role?: string; content?: string }>).filter((message) => message.role === "tool")
          : [],
      ).find((message) => message.content?.includes("<task_wait_target>"))?.content
      expect(toolResult).toBeDefined()
      const target = JSON.parse(toolResult!.match(/<task_wait_target>(.*?)<\/task_wait_target>/)?.[1] ?? "null")
      expect(target).toMatchObject({
        task_id: result.rows[0]?.child,
        invocation: { parent_session_id: result.parent },
      })
      expect(target.input_id).toStartWith("msg_")
      expect(target.invocation.parent_message_id).toStartWith("msg_")
      expect(target.invocation.call_id).toBeTruthy()
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
      expect(definitions).not.toContain('"name":"archive_unknown"')
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 60_000)

test("production V2 task_wait reports an invalid request as a failed tool call with repair guidance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PARENT_WAIT_INVALID_MARKER"),
        "task_wait",
        { targets: [], timeout_ms: 120_000 },
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('"name":"task_wait"'), "wait request corrected")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_DB: `${temp.path}/task-v2-wait-invalid.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { background_subagents: true },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_CONTROL: "wait-invalid",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      expect(stdout).toContain("TASK_V2_PARENT_RESULT:")
      const line = stdout.split("\n").find((item) => item.startsWith("TASK_V2_PARENT_RESULT:"))
      const session = JSON.parse(line!.slice("TASK_V2_PARENT_RESULT:".length)) as {
        messages: Array<{ data: { type: string; content?: Array<{ type: string; name?: string; state?: { status: string } }> } }>
      }
      expect(session.messages.flatMap((message) => message.data.content ?? []).find((part) => part.name === "task_wait")?.state?.status).toBe("error")
      const hits = yield* llm.hits
      const request = hits[1]?.body as { messages?: Array<{ role: string; content?: string }> }
      const result = request.messages?.find((message) => message.role === "tool")
      expect(result?.content).toContain("task_wait_invalid_request")
      expect(result?.content).toContain("1–32 unique exact task_wait_target values")
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

const realTarget = process.env.OPENCODE_REAL_REXD_TARGET
const realRexdTest = realTarget ? test : test.skip

realRexdTest("production V2 Task executes one harmless child tool on a real selected Rexd target", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: testProviderConfig(llm.url) })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const targetID = "00000000-0000-4000-8000-000000000001"
      const probe = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", realTarget!, "hostname"],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [remoteHost, probeError, probeCode] = yield* Effect.promise(() =>
        Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]),
      )
      expect(probeCode, probeError).toBe(0)
      expect(remoteHost.trim()).not.toBe(os.hostname())
      const configDirectory = path.join(temp.path, ".config/opencode")
      yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(configDirectory, "targets.jsonc"), JSON.stringify({
        version: 1,
        targets: {
          [targetID]: {
            name: realTarget,
            transport: "ssh",
            connection: { type: "ssh-config", host: realTarget },
            defaultDirectory: "/tmp",
            workspaceRoots: ["/"],
          },
        },
      })))
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("PARENT_TASK_MARKER"),
        "task",
        {
          description: "Check isolated remote directory",
          prompt: "CHILD_TASK_MARKER: run hostname once and report the host",
          subagent_type: "general",
          target: realTarget,
          directory: "/tmp",
          background: true,
        },
      )
      yield* llm.toolMatch(
        (hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"),
        "bash",
        { command: "hostname", description: "Read remote host name" },
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"), "remote child complete")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("PARENT_TASK_MARKER"), "parent continues")
      const child = Bun.spawn([process.execPath, "test/fixture/task-v2-parent-process.ts"], {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          OPENCODE_TEST_HOME: temp.path,
          XDG_CONFIG_HOME: path.join(temp.path, ".config"),
          XDG_DATA_HOME: path.join(temp.path, ".local/share"),
          XDG_STATE_HOME: path.join(temp.path, ".local/state"),
          OPENCODE_PURE: "1",
          OPENCODE_DB: `${temp.path}/task-v2-real-rexd.sqlite`,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            experimental: { background_subagents: true },
            providers: {
              test: {
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
                request: { body: { apiKey: "test-key" } },
                models: { "test-model": { api: { id: "test-model" } } },
              },
            },
          }),
          TASK_V2_TEST_DIRECTORY: temp.path,
          TASK_V2_TEST_LLM_URL: llm.url,
          TASK_V2_TEST_SETTLE: "true",
          TASK_V2_TEST_HTTP: "true",
          TASK_V2_TEST_STATUS: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      expect(code, stderr.slice(0, 4_096)).toBe(0)
      const line = stdout.split("\n").find((item) => item.startsWith("TASK_V2_PARENT_RESULT:"))
      expect(line).toBeDefined()
      const result = JSON.parse(line!.slice("TASK_V2_PARENT_RESULT:".length)) as {
        rows: Array<{ backend: string; state: string; outcome?: string; target?: { type: string; targetID: string }; directory?: string }>
        control: { status: { data: Array<{ location: { target_id?: string } }> }; interrupt: { state: string } }
      }
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ backend: "v2", state: "settled", outcome: "completed", target: { type: "rexd", targetID }, directory: "/tmp" })
      expect(result.control.status.data[0]?.location.target_id).toBe(targetID)
      expect(result.control.interrupt.state).toBe("already_settled")
      const hits = yield* llm.hits
      expect(hits.some((hit) => JSON.stringify(hit.body).includes("CHILD_TASK_MARKER"))).toBe(true)
      expect(hits.some((hit) => JSON.stringify(hit.body).includes(remoteHost.trim()))).toBe(true)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}, 90_000)

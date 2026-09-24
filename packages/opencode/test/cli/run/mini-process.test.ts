import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

async function runPty(input: { home: string; url: string; experimental: boolean; replies: string[] }) {
  let output = ""
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 32,
    data(_terminal, data) {
      output += new TextDecoder().decode(data)
    },
  })
  const proc = Bun.spawn(
    [
      "bun", "run", path.resolve(import.meta.dir, "../../../src/index.ts"),
      "--mini", "--prompt", "mini hello", "--model", "test/test-model",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: input.home,
        HOME: input.home,
        XDG_CONFIG_HOME: path.join(input.home, ".config"),
        XDG_DATA_HOME: path.join(input.home, ".local/share"),
        XDG_STATE_HOME: path.join(input.home, ".local/state"),
        XDG_CACHE_HOME: path.join(input.home, ".cache"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(
          input.experimental
            ? {
                experimental: { background_subagents: true },
                providers: {
                  test: {
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: input.url },
                    request: { body: { apiKey: "test-key" } },
                    models: { "test-model": { api: { id: "test-model" } } },
                  },
                },
              }
            : testProviderConfig(input.url),
        ),
        OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: input.experimental ? "1" : "0",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_AUTH_CONTENT: "{}",
        NODE_ENV: "production",
      },
      terminal,
      stderr: "pipe",
    },
  )
  try {
    for (const [index, reply] of input.replies.entries()) {
      if (index > 0) terminal.write("second mini\r")
      const deadline = Date.now() + 10_000
      while (!stripVTControlCharacters(output).includes(reply)) {
        if (proc.exitCode !== null)
          throw new Error(`mini exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`)
        if (Date.now() >= deadline)
          throw new Error(`mini reply missing: ${reply}; output: ${stripVTControlCharacters(output).slice(-1000)}`)
        await Bun.sleep(20)
      }
    }
    return stripVTControlCharacters(output)
  } finally {
    terminal.write("\x03")
    await Promise.race([proc.exited, Bun.sleep(1_000).then(() => proc.kill())])
    terminal.close()
  }
}

cliIt.live(
  "mini displays two V2 provider replies after returning to its prompt",
  ({ llm, home }) =>
    Effect.gen(function* () {
      yield* llm.text("canonical mini reply")
      yield* llm.text("second mini reply")
      const output = yield* Effect.promise(() =>
        runPty({ home, url: llm.url, experimental: true, replies: ["canonical mini reply", "second mini reply"] }),
      )
      expect(output).toContain("canonical mini reply")
      expect(output).toContain("second mini reply")
      expect(yield* llm.inputs).toHaveLength(2)
    }),
  30_000,
)

cliIt.live(
  "mini keeps the legacy provider path when background subagents are disabled",
  ({ llm, home }) =>
    Effect.gen(function* () {
      yield* llm.text("legacy mini reply")
      const output = yield* Effect.promise(() =>
        runPty({ home, url: llm.url, experimental: false, replies: ["legacy mini reply"] }),
      )
      expect(output).toContain("legacy mini reply")
      const inputs = yield* llm.inputs
      expect(inputs.length).toBeGreaterThanOrEqual(1)
    }),
  30_000,
)

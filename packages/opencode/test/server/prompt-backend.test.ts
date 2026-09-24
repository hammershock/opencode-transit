import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

test("V2 prompt backend preserves an existing legacy assistant transcript", async () => {
  await using temp = await tmpdir({ git: true })
  const child = Bun.spawn([process.execPath, "test/fixture/prompt-backend-http.ts"], {
    cwd: import.meta.dir + "/../..",
    env: {
      ...process.env,
      OPENCODE_DB: `${temp.path}/prompt-backend.sqlite`,
      PROMPT_BACKEND_TEST_DIRECTORY: temp.path,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr.slice(0, 4_096)).toBe(0)
  const result = JSON.parse(
    stdout.split("\n").find((line) => line.startsWith("PROMPT_BACKEND_HTTP:"))!.slice("PROMPT_BACKEND_HTTP:".length),
  ) as {
    empty: { status: number; body: { data: string } }
    emptyPrompt: { status: number }
    legacy: { status: number; body: { data: string } }
    blocked: { status: number }
    blockedSkill: { status: number }
  }
  expect(result.empty).toEqual({ status: 200, body: { data: "v2" } })
  expect(result.emptyPrompt.status).toBe(200)
  expect(result.legacy).toEqual({ status: 200, body: { data: "legacy" } })
  expect(result.blocked.status, JSON.stringify(result) + stderr.slice(0, 4_096)).toBe(409)
  expect(result.blockedSkill.status, JSON.stringify(result)).toBe(409)
}, 45_000)

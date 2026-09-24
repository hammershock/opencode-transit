import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { tmpdir } from "../fixture/fixture"

test("two controllers atomically choose one prompt backend for an empty Session", async () => {
  await using temp = await tmpdir({ git: true })
  const base = {
    ...process.env,
    OPENCODE_DB: `${temp.path}/prompt-race.sqlite`,
    PROMPT_RACE_DIRECTORY: temp.path,
  }
  const run = async (mode: string, sessionID?: string) => {
    const child = Bun.spawn([process.execPath, "test/fixture/prompt-backend-race.ts"], {
      cwd: import.meta.dir + "/../..",
      env: { ...base, PROMPT_RACE_MODE: mode, ...(sessionID ? { PROMPT_RACE_SESSION: sessionID } : {}) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const result = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const timed = await Promise.race([result.then((value) => ({ kind: "done" as const, value })), Bun.sleep(20_000).then(() => ({ kind: "timeout" as const }))])
    if (timed.kind === "timeout") {
      child.kill()
      const [stdout, stderr] = await result
      throw new Error(`Prompt race ${mode} timed out: stdout=${stdout.slice(0, 2_000)} stderr=${stderr.slice(0, 4_000)}`)
    }
    const [stdout, stderr, code] = timed.value
    expect(code, stderr.slice(0, 4_096)).toBe(0)
    expect(stderr, stderr.slice(0, 4_096)).not.toMatch(/SQLITE_BUSY|SqliteError|PromptBackendConflict/)
    return JSON.parse(stdout.split("\n").find((line) => line.startsWith("PROMPT_RACE:"))!.slice("PROMPT_RACE:".length))
  }
  const created = await run("create") as { status: number; body: { data: { id: string } } }
  expect(created.status).toBe(200)
  const controllers = [run("v1", created.body.data.id), run("v2", created.body.data.id)]
  for (let attempt = 0; attempt < 400; attempt++) {
    if (existsSync(`${temp.path}/prompt-race-v1.ready`) && existsSync(`${temp.path}/prompt-race-v2.ready`)) break
    if (attempt === 399) throw new Error("Controllers never reached the prompt barrier")
    await Bun.sleep(10)
  }
  await Bun.write(`${temp.path}/prompt-race.start`, "go")
  const outcomes = await Promise.all(controllers) as Array<{ mode: string; status: number; failure?: string; detail?: string; body?: string }>
  expect(outcomes.map((item) => item.status).filter((status) => status === 200)).toHaveLength(1)
  expect(outcomes.map((item) => item.status).sort(), JSON.stringify(outcomes)).toEqual([200, 409])
  const loser = outcomes.find((item) => item.status === 409)!
  if (loser.mode === "v2") expect(loser.failure).toBe("PromptBackendConflict")
  else expect(loser.body).toContain("Conflict")
  const rows = await run("inspect", created.body.data.id) as { v1: number; v2: number }
  expect(rows.v1 > 0 && rows.v2 > 0).toBe(false)
  expect(rows.v1 + rows.v2).toBe(1)
}, 60_000)

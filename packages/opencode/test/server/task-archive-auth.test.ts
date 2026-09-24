import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

test("private TUI archive rejects a cross-project request without changing durable Task state", async () => {
  await using tmp = await tmpdir({ git: true })
  const db = `${tmp.path}/task-control-http.sqlite`
  const setup = Bun.spawn([process.execPath, "test/fixture/task-control-http.ts"], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, OPENCODE_DB: db, TASK_CONTROL_HTTP_DIRECTORY: tmp.path },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [setupOutput, setupError, setupCode] = await Promise.all([
    new Response(setup.stdout).text(),
    new Response(setup.stderr).text(),
    setup.exited,
  ])
  expect(setupCode, setupError).toBe(0)
  const line = setupOutput.split("\n").find((item) => item.startsWith("TASK_CONTROL_HTTP:"))
  expect(line).toBeDefined()
  const receipt = JSON.parse(line!.slice("TASK_CONTROL_HTTP:".length)) as {
    parent: string
    child: string
    first: string
  }
  const check = Bun.spawn([process.execPath, "test/fixture/task-archive-auth.ts"], {
    cwd: import.meta.dir + "/../..",
    env: {
      ...process.env,
      OPENCODE_DB: db,
      TASK_ARCHIVE_PARENT: receipt.parent,
      TASK_ARCHIVE_CHILD: receipt.child,
      TASK_ARCHIVE_INPUT: receipt.first,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [checkOutput, checkError, checkCode] = await Promise.all([
    new Response(check.stdout).text(),
    new Response(check.stderr).text(),
    check.exited,
  ])
  expect(checkCode, checkError).toBe(0)
  expect(checkOutput).toContain("TASK_ARCHIVE_REJECTED")
}, 30_000)

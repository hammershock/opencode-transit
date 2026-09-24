import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("aborting an HTTP Task wait releases its subscription without stopping the child", async () => {
  await using temp = await tmpdir()
  const process = Bun.spawn(
    [
      "bun",
      path.join(import.meta.dir, "fixtures", "task-wait-abort.ts"),
      path.resolve(import.meta.dir, "../../../.."),
      temp.path,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const exit = await process.exited
  const output = await new Response(process.stdout).text()
  const errors = await new Response(process.stderr).text()
  expect(exit, errors).toBe(0)
  expect(output).toContain("HTTP abort released Task owner watcher")
})

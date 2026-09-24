import { expect, test } from "bun:test"
import { stopOperationKey, submitTaskStop } from "../../../src/util/task-stop-retry"

test("lost stop response retries its original scope after a later invocation is admitted", async () => {
  const values = new Map<string, string>()
  const store = {
    get: (key: string) => values.get(key),
    set: async (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
  const server = new Map<string, string[]>()
  const tasks = ["A", "B", "C"]
  const send = async (operationID: string) => {
    const covered = server.get(operationID) ?? [...tasks]
    server.set(operationID, covered)
    if (tasks.length === 3) throw new Error("response lost")
    return covered
  }
  const input = { store, parentSessionID: "ses_parent", childSessionID: "ses_child", send }
  await expect(submitTaskStop({ ...input, retry: false })).rejects.toThrow("response lost")
  const original = values.get(stopOperationKey("ses_parent", "ses_child"))
  expect(original).toBeDefined()
  tasks.push("D")
  await expect(submitTaskStop({ ...input, retry: false })).rejects.toThrow("Retry the original")
  expect(await submitTaskStop({ ...input, retry: true })).toEqual(["A", "B", "C"])
  expect(server.get(original!)).toEqual(["A", "B", "C"])
  expect(values.size).toBe(0)
})

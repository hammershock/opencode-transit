import { Database } from "bun:sqlite"
import { Rpc } from "@/util/rpc"
import { tmpdir } from "./fixture"

const dbPath = process.env.OPENCODE_DB
const parent = process.env.TASK_ARCHIVE_PARENT
const child = process.env.TASK_ARCHIVE_CHILD
const input = process.env.TASK_ARCHIVE_INPUT
if (!dbPath || !parent || !child || !input) throw new Error("Missing archive authorization fixture input")

await using foreign = await tmpdir({ git: true })
const worker = new Worker(new URL("../../src/cli/tui/worker.ts", import.meta.url).href, {
  preload: [],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
})
const client = Rpc.client<typeof import("../../src/cli/tui/worker").rpc>(worker)
const database = new Database(dbPath, { readonly: true })
const row = () => database.query("SELECT state, outcome, disposition_operation_id FROM session_task WHERE input_id = ?").get(input)
try {
  const before = row()
  const result = await client.call("archiveUnknown", {
    directory: foreign.path,
    parentSessionID: parent,
    childSessionID: child,
    inputID: input,
    operationID: "forged-cross-project",
  }).then(() => "accepted", () => "rejected")
  if (result !== "rejected" || JSON.stringify(row()) !== JSON.stringify(before))
    throw new Error("Cross-project archive changed durable Task state")
  process.stdout.write("TASK_ARCHIVE_REJECTED\n")
} finally {
  client.dispose()
  await worker.terminate()
  database.close()
}

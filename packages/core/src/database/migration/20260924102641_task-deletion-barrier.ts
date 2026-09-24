import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924102641_task-deletion-barrier",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_deletion\` (
          \`session_id\` text PRIMARY KEY
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration

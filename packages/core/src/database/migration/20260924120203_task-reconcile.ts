import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924120203_task-reconcile",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_operation\` (
          \`operation_id\` text PRIMARY KEY,
          \`input_id\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`disposition\` text NOT NULL,
          \`capacity_state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_task_operation_input_id_session_task_input_id_fk\` FOREIGN KEY (\`input_id\`) REFERENCES \`session_task\`(\`input_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_input_idx\` ON \`session_task_operation\` (\`input_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

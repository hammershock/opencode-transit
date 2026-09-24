import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924150628_smooth_the_phantom",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_stop\` (
          \`operation_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`intent\` text NOT NULL,
          \`members\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_task_stop_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration

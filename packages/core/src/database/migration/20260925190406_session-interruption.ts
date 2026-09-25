import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925190406_session-interruption",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_execution_pause\` (
          \`session_id\` text PRIMARY KEY,
          \`operation_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_pause_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_interruption\` (
          \`operation_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`backend\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_requested\` integer NOT NULL,
          \`time_settled\` integer,
          CONSTRAINT \`fk_session_interruption_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_interruption_session_time_idx\` ON \`session_interruption\` (\`session_id\`,\`time_requested\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

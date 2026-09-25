import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925213602_session-agent-activity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_agent_activity\` (
          \`event_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`subject_session_id\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`wait_call_id\` text,
          \`actor_kind\` text,
          CONSTRAINT \`fk_session_agent_activity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_agent_wait\` (
          \`id\` text PRIMARY KEY,
          \`call_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`targets\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_finished\` integer,
          CONSTRAINT \`fk_session_agent_wait_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_agent_activity_session_seq_idx\` ON \`session_agent_activity\` (\`session_id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

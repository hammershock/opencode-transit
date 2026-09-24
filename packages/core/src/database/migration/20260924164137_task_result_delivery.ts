import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924164137_task_result_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_result\` (
          \`invocation_input_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`terminal_event_id\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`result_message_id\` text,
          \`summary\` text NOT NULL,
          \`notification_input_id\` text NOT NULL UNIQUE,
          \`notify\` integer NOT NULL,
          \`version\` integer NOT NULL,
          CONSTRAINT \`fk_session_task_result_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task_wake_revocation\` (
          \`invocation_input_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`stop_event_id\` text NOT NULL,
          CONSTRAINT \`fk_session_task_wake_revocation_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`origin\` text;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`background\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`terminal_event_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

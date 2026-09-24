import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924090759_task-invocation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task\` (
          \`input_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`parent_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`prompt_digest\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`description\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`location_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`backend\` text NOT NULL,
          \`outcome\` text,
          \`result_message_id\` text,
          \`abandoned_unknown\` integer DEFAULT false NOT NULL,
          \`archive_operation_id\` text,
          \`archive_actor_id\` text,
          \`archive_time\` integer,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_settled\` integer,
          \`owner_pid\` integer,
          \`owner_start\` text,
          \`owner_generation\` text,
          \`owner_observed_at\` integer,
          CONSTRAINT \`fk_session_task_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_parent_call_idx\` ON \`session_task\` (\`parent_message_id\`,\`call_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_archive_operation_idx\` ON \`session_task\` (\`archive_operation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_root_state_idx\` ON \`session_task\` (\`root_session_id\`,\`state\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_child_state_idx\` ON \`session_task\` (\`child_session_id\`,\`state\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

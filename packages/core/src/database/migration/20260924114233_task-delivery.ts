import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924114233_task-delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_steer\` (
          \`input_id\` text PRIMARY KEY,
          \`invocation_input_id\` text NOT NULL,
          \`operation_id\` text NOT NULL,
          \`prompt_digest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_promoted\` integer,
          \`time_not_delivered\` integer,
          CONSTRAINT \`fk_session_task_steer_input_id_session_input_id_fk\` FOREIGN KEY (\`input_id\`) REFERENCES \`session_input\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_steer_invocation_input_id_session_task_input_id_fk\` FOREIGN KEY (\`invocation_input_id\`) REFERENCES \`session_task\`(\`input_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`eligibility\` text DEFAULT 'eligible' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`disposition_operation_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`disposition_actor_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`disposition_time\` integer;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_steer_operation_idx\` ON \`session_task_steer\` (\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_steer_invocation_idx\` ON \`session_task_steer\` (\`invocation_input_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_disposition_operation_idx\` ON \`session_task\` (\`disposition_operation_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

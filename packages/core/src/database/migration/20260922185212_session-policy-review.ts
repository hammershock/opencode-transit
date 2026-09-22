import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922185212_session-policy-review",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_policy_activation\` (
          \`session_id\` text NOT NULL,
          \`device_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`location\` text NOT NULL,
          CONSTRAINT \`session_policy_activation_pk\` PRIMARY KEY(\`session_id\`, \`device_id\`, \`request_id\`),
          CONSTRAINT \`fk_session_policy_activation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_policy_review\` (
          \`session_id\` text NOT NULL,
          \`device_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_policy_review_pk\` PRIMARY KEY(\`session_id\`, \`device_id\`, \`request_id\`),
          CONSTRAINT \`fk_session_policy_review_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_revision\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration

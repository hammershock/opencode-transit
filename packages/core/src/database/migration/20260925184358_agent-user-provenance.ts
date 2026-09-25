import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925184358_agent-user-provenance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_peer_user_message\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_peer_user_message_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_session_peer_user_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration

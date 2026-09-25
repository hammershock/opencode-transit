import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925194641_session-peer-message",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_peer_message\` (
          \`id\` text PRIMARY KEY,
          \`operation_id\` text NOT NULL UNIQUE,
          \`source_session_id\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`request_id\` text,
          \`reply_id\` text,
          \`text\` text NOT NULL,
          \`backend\` text NOT NULL,
          \`queued\` integer DEFAULT false NOT NULL,
          \`resume\` integer DEFAULT false NOT NULL,
          \`delivery\` text DEFAULT 'admitted' NOT NULL,
          \`failure_reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_peer_receipt\` (
          \`message_id\` text PRIMARY KEY,
          \`receiver_session_id\` text NOT NULL,
          \`channel\` text NOT NULL,
          \`time_consumed\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_peer_message_target_time_idx\` ON \`session_peer_message\` (\`target_session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_peer_message_source_time_idx\` ON \`session_peer_message\` (\`source_session_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_peer_message_request_idx\` ON \`session_peer_message\` (\`request_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

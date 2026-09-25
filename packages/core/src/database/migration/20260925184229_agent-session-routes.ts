import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925184229_agent-session-routes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_peer_route\` (
          \`source_session_id\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`origin_kind\` text NOT NULL,
          \`origin_id\` text NOT NULL,
          \`can_inspect\` integer DEFAULT true NOT NULL,
          \`can_interact\` integer DEFAULT true NOT NULL,
          \`can_interrupt\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_peer_route_pk\` PRIMARY KEY(\`source_session_id\`, \`alias\`),
          CONSTRAINT \`fk_session_peer_route_source_session_id_session_id_fk\` FOREIGN KEY (\`source_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_peer_route_target_session_id_session_id_fk\` FOREIGN KEY (\`target_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_peer_route_target_idx\` ON \`session_peer_route\` (\`target_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

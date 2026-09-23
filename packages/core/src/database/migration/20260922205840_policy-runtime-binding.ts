import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922205840_policy-runtime-binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_policy_device\` (
          \`id\` integer PRIMARY KEY,
          \`device_id\` text NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_boundary\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

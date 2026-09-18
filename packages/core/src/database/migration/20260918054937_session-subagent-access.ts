import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918054937_session-subagent-access",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_access\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

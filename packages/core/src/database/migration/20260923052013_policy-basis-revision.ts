import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923052013_policy-basis-revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_basis_revision\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration

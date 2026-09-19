export * as RuntimeContextBuiltIns from "./builtins"

import { Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { SessionSkillCatalog } from "../session/skill-catalog"
import { RuntimeContext } from "./index"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext.Service
    const db = (yield* Database.Service).db
    yield* runtime.register({
      key: "skills",
      label: "Available skills",
      tag: "<available_skills>",
      order: 10,
      enabled: () => true,
      render: (sessionID) => SessionSkillCatalog.guidance(db, sessionID),
    })
  }),
)

export const node = makeLocationNode({
  name: "runtime-context-builtins",
  layer: builtIns,
  deps: [Database.node, RuntimeContext.node],
})

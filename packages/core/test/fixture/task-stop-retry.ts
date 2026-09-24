import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTask } from "@opencode-ai/core/session/task"
import { SessionTaskControl } from "@opencode-ai/core/session/task-control"

const [filename, root, child, operationID, later] = process.argv.slice(2)
if (!filename || !root || !child || !operationID || !later) throw new Error("Missing stop retry fixture arguments")
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionExecution.node]),
  [
    [Database.node, Database.layerFromPath(filename)],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const receipt = yield* SessionTaskControl.stop({
      parentSessionID: SessionSchema.ID.make(root),
      childSessionID: SessionSchema.ID.make(child),
      operationID,
      actor: { kind: "parent", id: root },
    })
    return { receipt, later: (yield* SessionTask.find(database.db, later))?.state }
  }).pipe(Effect.provide(layer), Effect.scoped),
)
process.stdout.write(`TASK_STOP_RETRY:${JSON.stringify(result)}\n`)

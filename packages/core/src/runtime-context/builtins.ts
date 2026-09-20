export * as RuntimeContextBuiltIns from "./builtins"

import { DateTime, Effect, Layer } from "effect"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { InstructionContext, render } from "../instruction-context"
import { Location } from "../location"
import { Reference } from "../reference"
import { SessionSkillCatalog } from "../session/skill-catalog"
import { RuntimeContext } from "./index"

export const skillsPart = {
  key: "skills",
  label: "Available skills",
  tag: "<available_skills>",
  order: 4,
} as const

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext.Service
    const db = (yield* Database.Service).db
    const location = yield* Location.Service
    const instructions = yield* InstructionContext.Service
    const references = yield* Reference.Service

    yield* runtime.register({
      key: "environment",
      label: "Environment",
      tag: "<environment>",
      order: 0,
      cache: "session",
      enabled: () => true,
      render: () => Effect.succeed(renderEnvironment(buildEnvironment(location))),
    })

    yield* runtime.register({
      key: "date",
      label: "Date",
      tag: "<date>",
      order: 1,
      cache: "turn",
      enabled: () => true,
      render: () =>
        Effect.gen(function* () {
          const date = yield* DateTime.nowAsDate
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
          return `Current date: ${date.toDateString()}\nUser timezone: ${timezone}`
        }),
    })

    yield* runtime.register({
      key: "instructions",
      label: "Instructions",
      tag: "<instructions>",
      order: 2,
      cache: "session",
      enabled: () => true,
      render: (sessionID) =>
        Effect.gen(function* () {
          const text = render(yield* instructions.list(sessionID))
          return text.length > 0 ? text : undefined
        }),
    })

    yield* runtime.register({
      key: "references",
      label: "References",
      tag: "<available_references>",
      order: 3,
      cache: "session",
      enabled: () => true,
      render: () =>
        Effect.gen(function* () {
          const available = (yield* references.list())
            .filter((reference) => reference.description !== undefined)
            .map((reference) => ({
              name: reference.name,
              path: reference.path,
              description: reference.description,
            }))
          if (available.length === 0) return undefined
          return renderReferences(available)
        }),
    })

    yield* runtime.register({
      ...skillsPart,
      enabled: () => true,
      render: (sessionID) => SessionSkillCatalog.guidance(db, sessionID),
    })
  }),
)

export const node = makeLocationNode({
  name: "runtime-context-builtins",
  layer: builtIns,
  deps: [Database.node, Location.node, InstructionContext.node, Reference.node, RuntimeContext.node],
})

export function buildEnvironment(location: Location.Interface) {
  return ModelContext.Environment.make({
    harness: "OpenCode Transit",
    entrypoint: "opencode-transit",
    targetKind: location.target.type,
    targetName:
      location.targetName ?? location.lastKnownTargetName ?? (location.target.type === "local" ? "local" : "remote"),
    directory: location.directory,
    projectRoot: location.project.directory,
    vcs: location.vcs?.type,
    platform: location.platform ?? "unknown",
  })
}

export function renderEnvironment(environment: ModelContext.Environment) {
  return [
    `Execution harness: ${environment.harness} (${environment.entrypoint})`,
    "<environment>",
    `  Target: ${environment.targetKind} (${environment.targetName})`,
    `  Working directory: ${environment.directory}`,
    `  Project root: ${environment.projectRoot}`,
    `  VCS: ${environment.vcs ?? "none"}`,
    `  Platform: ${environment.platform}`,
    "</environment>",
  ].join("\n")
}

function renderReferences(references: ReadonlyArray<{ name: string; path: string; description?: string }>) {
  return [
    "Project references provide additional directories that can be accessed when relevant.",
    "<available_references>",
    ...references.flatMap((reference) => [
      "  <reference>",
      `    <name>${reference.name}</name>`,
      `    <path>${reference.path}</path>`,
      ...(reference.description === undefined ? [] : [`    <description>${reference.description}</description>`]),
      "  </reference>",
    ]),
    "</available_references>",
  ].join("\n")
}

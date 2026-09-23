export * as SkillPackageAccess from "./package-access"

import path from "path"
import { Skill } from "@opencode-ai/schema/skill"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { AbsolutePath } from "../schema"
import { SkillRegistry } from "./registry"
import { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"

export interface Prepared {
  readonly path?: AbsolutePath
  readonly temporary: boolean
}

export interface Interface {
  readonly paths: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<AbsolutePath>>
  readonly prepare: (input: {
    readonly entry: SkillRegistry.Entry
    readonly sessionID: SessionSchema.ID
    readonly signal?: AbortSignal
  }) => Effect.Effect<Prepared, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillPackageAccess") {}

export class Failure extends Schema.TaggedErrorClass<Failure>()("SkillPackageAccess.Failure", {
  skillID: Skill.ID,
  kind: Schema.Literals(["unavailable"]),
}) {}

export const toModelContent = (input: {
  readonly name: string
  readonly content: string
  readonly prepared?: Prepared
}) =>
  [
    `# Skill: ${input.name}`,
    "",
    input.content.trim(),
    "",
    ...(input.prepared?.path === undefined
      ? ["This Skill has no filesystem package directory."]
      : input.prepared.temporary
        ? [
            `Temporary package directory on this execution target: ${input.prepared.path}`,
            "This is a shared, mutable runtime copy and can be reclaimed when the Session disconnects or expires.",
            "Before starting persistent background work, copy every required file into a persistent target directory.",
            "Use the ordinary filesystem and shell tools to read, modify, or execute files in this directory.",
          ]
        : [
            `Package directory: ${input.prepared.path}`,
            "Relative paths in this Skill are relative to this directory.",
            "Use the ordinary filesystem and shell tools to read, modify, or execute files in this directory.",
          ]),
  ].join("\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const prepared = new Map<SessionSchema.ID, Set<AbsolutePath>>()
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === SessionV1.Event.Deleted.type)
          prepared.delete((event as EventV2.Payload<typeof SessionV1.Event.Deleted>).data.sessionID)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({
      paths: (sessionID) => Effect.sync(() => [...(prepared.get(sessionID) ?? [])]),
      prepare: Effect.fn("SkillPackageAccess.prepare")(function* (input) {
        if (input.entry.source.kind === "built-in") return { temporary: false }
        const directory = AbsolutePath.make(path.dirname(input.entry.location))
        const current = prepared.get(input.sessionID) ?? new Set<AbsolutePath>()
        current.add(directory)
        prepared.set(input.sessionID, current)
        return { path: directory, temporary: false }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })

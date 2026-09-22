export * as AgentPermission from "./agent-permission"

import path from "path"
import { Effect, Exit, type LayerMap } from "effect"
import { Location } from "@opencode-ai/core/location"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Reference } from "@opencode-ai/core/reference"
import { SkillV2 } from "@opencode-ai/core/skill"

export interface ResolveInput {
  readonly location: Location.Ref
  readonly withReferences: boolean
}

/**
 * Resolve the location-scoped `external_directory` whitelist for an execution
 * location: the skill and reference directories the agent may access on that
 * target without an `external_directory` approval.
 *
 * Skill discovery is controller-owned but its package paths are Location
 * scoped, so both are resolved through the Location provider for `location`.
 * Skill resolution degrades to an empty list when the location is unavailable
 * (matching the legacy `Skill.compatibilityCatalog` behavior); reference
 * resolution is only attempted when references are configured and fails hard.
 * Returns `/*`-suffixed glob patterns matching the existing `Agent.state`
 * whitelist shape.
 */
export function resolve(
  locations: LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
  input: ResolveInput,
) {
  const provide = locations.get(input.location)

  const skillDirs = Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
    const catalog = yield* (yield* SkillV2.Service).catalog()
    return Array.from(
      new Set(
        catalog.entries
          .filter((entry) => entry.source.kind !== "built-in")
          .map((entry) => path.dirname(entry.location)),
      ),
    ).toSorted()
  }).pipe(
    Effect.provide(provide),
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : [])),
  )

  const referenceDirs = input.withReferences
    ? Effect.gen(function* () {
        yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
        return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
      }).pipe(Effect.provide(provide))
    : Effect.succeed([])

  return Effect.gen(function* () {
    const skills = yield* skillDirs
    const references = yield* referenceDirs
    return [
      ...skills.map((dir) => path.join(dir, "*")),
      ...references.map((dir) => path.join(dir, "*")),
    ]
  })
}

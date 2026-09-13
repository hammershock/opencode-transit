/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeTransitContent from "./skill/customize-opencode-transit.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeTransitContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* () {
    const skill = yield* SkillV2.Service
    yield* skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode-transit",
            description:
              "Use ONLY when the user is editing or creating opencode-transit configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing agents, subagents, commands, skills, plugins, MCP servers, permission rules, or Skill discovery and invocation. Do not use for the user's own application code or for projects that are not configuring opencode-transit.",
            location: AbsolutePath.make("/builtin/customize-opencode-transit.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
        // Target scopes are keyed by SkillID, so the user-facing rename must retain
        // the identity inputs used by the original customize-opencode registration.
        { identity: "opencode/customize-opencode", identityName: "customize-opencode" },
      )
    })
  }),
})

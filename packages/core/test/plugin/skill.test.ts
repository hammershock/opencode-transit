import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-opencode-transit skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      const skills = yield* skill.list()
      const registered = (yield* skill.catalog()).snapshot.skills[0]

      expect(skills).toHaveLength(1)
      expect(registered).toEqual(
        expect.objectContaining({
          id: "skl_887d991222ceee0845a4816256a2729bd4c1321a388ebff06a4aea4e2fba931b",
          name: "customize-opencode-transit",
          description: expect.stringContaining("opencode-transit"),
        }),
      )
    }),
  )
})

import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

test.each([true, false])("background setting roundtrips through both config schemas: %s", (value) => {
  const input = { experimental: { background_subagents: value } }
  expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.background_subagents).toBe(value)
  const legacy = Schema.decodeUnknownSync(ConfigV1.Info)(input)
  expect(legacy.experimental?.background_subagents).toBe(value)
  expect(ConfigMigrateV1.migrate(legacy).experimental?.background_subagents).toBe(value)
})

test.each([
  [undefined, false, false],
  [undefined, true, true],
  [false, false, false],
  [false, true, false],
  [true, false, true],
  [true, true, true],
] as const)("background config %s with environment %s resolves to %s", (setting, fallback, expected) => {
  expect(ConfigExperimental.backgroundSubagents({ experimental: { background_subagents: setting } }, fallback)).toBe(
    expected,
  )
})

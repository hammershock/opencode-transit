import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem } from "../src/filesystem"
import { Harness } from "../src/harness"
import { ModelContext } from "../src/model-context"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })

  test("model context instructions decode both legacy and target sources at version 1", () => {
    expect(
      Schema.decodeUnknownSync(ModelContext.Instruction)({
        id: "legacy-global",
        origin: "global-file",
        scope: "global",
        source: "<user-config>/AGENTS.md",
        status: "loaded",
        content: "legacy rules",
      }),
    ).toMatchObject({ origin: "global-file", scope: "global" })
    expect(
      Schema.decodeUnknownSync(ModelContext.Instruction)({
        id: "target-profile",
        origin: "target-file",
        scope: "target",
        source: "<target-config>/AGENTS.md",
        status: "loaded",
        content: "target rules",
      }),
    ).toMatchObject({ origin: "target-file", scope: "target" })
  })

  test("harness instruction settings decode the version 1 shared-reference contract", () => {
    const decoded = Schema.decodeUnknownSync(Harness.InstructionSettingsSnapshot)({
      version: 1,
      path: "/controller/config/harness.jsonc",
      revision: "0".repeat(64),
      global: "policies/global.md",
      targets: [
        { target: "local", reference: "policies/shared.md" },
        { target: "11111111-1111-4111-8111-111111111111", reference: "policies/shared.md" },
      ],
      diagnostics: [],
      valid: true,
    })

    expect(decoded.version).toBe(1)
    expect(decoded.targets.map((item) => item.reference)).toEqual(["policies/shared.md", "policies/shared.md"])
    expect(Schema.encodeSync(Harness.InstructionSettingsSnapshot)(decoded)).toMatchObject({
      version: 1,
      global: "policies/global.md",
      targets: [{ target: "local" }, { target: "11111111-1111-4111-8111-111111111111" }],
    })
  })

  test("model context generation reasons preserve version 1 values and add explicit instruction application", () => {
    expect(Schema.decodeUnknownSync(ModelContext.GenerationReason)("created")).toBe("created")
    expect(Schema.decodeUnknownSync(ModelContext.GenerationReason)("init")).toBe("init")
    expect(Schema.decodeUnknownSync(ModelContext.GenerationReason)("instructions-applied")).toBe("instructions-applied")
  })
})

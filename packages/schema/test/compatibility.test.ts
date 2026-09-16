import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem } from "../src/filesystem"
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
})

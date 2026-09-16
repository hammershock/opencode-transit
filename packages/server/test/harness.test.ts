import { describe, expect, test } from "bun:test"
import type { HarnessInstructions } from "@opencode-ai/core/harness/instructions"
import { boundedSource } from "../src/handlers/harness"

type InstructionSource = Awaited<ReturnType<HarnessInstructions.Interface["validate"]>>

describe("HarnessHandler", () => {
  test("bounds controller file previews without changing the reported source size", () => {
    const content = "x".repeat(20_000)
    const source: InstructionSource = {
      reference: "policies/shared.md",
      resolved: "/controller/config/policies/shared.md" as InstructionSource["resolved"],
      status: "readable",
      content,
      size: content.length,
      digest: "full-content-digest",
      sharedTargets: ["local"],
    }

    expect(boundedSource(source)).toMatchObject({
      content: "x".repeat(16_384),
      size: 20_000,
      digest: "full-content-digest",
      truncated: true,
    })
    expect(boundedSource({ ...source, content: "short", size: 5 })).toEqual({
      ...source,
      content: "short",
      size: 5,
    })
  })
})

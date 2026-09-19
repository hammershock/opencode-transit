import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Target } from "../src/target"

const input = {
  name: "a100-2gpu",
  transport: "ssh" as const,
  connection: { type: "ssh-config" as const, host: "modelarts" },
  workspaceRoots: ["/home/ma-user/workspace"],
}

describe("Target", () => {
  test("omits an absent optional description when encoding", () => {
    expect(Schema.encodeSync(Target.Input)(input)).toEqual(input)
  })

  test("round-trips a description", () => {
    const described = { ...input, description: "Huawei ModelArts 2×A100 GPU server" }
    expect(Schema.decodeUnknownSync(Target.Input)(described)).toEqual(described)
    expect(Schema.encodeSync(Target.Input)(described)).toEqual(described)
  })
})

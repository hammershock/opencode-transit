import { describe, expect, test } from "bun:test"
import type { HarnessInstructionRead, ModelContextGeneration } from "@opencode-ai/sdk/v2"
import {
  instructionAdmissionStatus,
  instructionFileStatus,
  instructionPreview,
} from "../../src/component/harness-manager"

const globalRead: HarnessInstructionRead = {
  scope: { type: "global" },
  mode: "custom",
  source: {
    reference: "policies/shared.md",
    resolved: "/controller/config/policies/shared.md",
    status: "readable",
    content: "saved policy",
    size: 24_000,
    truncated: true,
    sharedTargets: ["local", "11111111-1111-4111-8111-111111111111"],
  },
  diagnostics: [],
}

const generation = {
  generation: 4,
  instructions: [
    {
      origin: "global-file",
      scope: "global",
      status: "loaded",
      content: "saved policy",
    },
  ],
} as ModelContextGeneration

describe("harness manager", () => {
  test("reports saved versus admitted state without treating save as application", () => {
    expect(instructionFileStatus(globalRead)).toBe("● readable")
    expect(instructionAdmissionStatus(globalRead, generation)).toBe("● admitted")
    expect(
      instructionAdmissionStatus(
        { ...globalRead, source: { ...globalRead.source!, content: "new saved policy" } },
        generation,
      ),
    ).toBe("! saved only")
    expect(
      instructionAdmissionStatus(
        { scope: { type: "target", target: "local" }, mode: "unset", diagnostics: [] },
        generation,
      ),
    ).toBe("● admitted")
    expect(
      instructionAdmissionStatus(
        { ...globalRead, source: { ...globalRead.source!, status: "missing", content: undefined } },
        generation,
      ),
    ).toBe("! unavailable")
  })

  test("renders controller ownership, bounded preview state, and sharing targets", () => {
    const preview = instructionPreview("Global", globalRead, (target) =>
      target === "local" ? "local" : "shared-cluster",
    )

    expect(preview).toContain("Controller  /controller/config/policies/shared.md")
    expect(preview).toContain("Shared      local, shared-cluster")
    expect(preview).toContain("Preview (truncated)")
    expect(preview).toContain("saved policy")
  })
})

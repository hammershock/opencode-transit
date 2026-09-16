import { describe, expect, test } from "bun:test"
import type {
  HarnessInstructionRead,
  HarnessInstructionSettingsSnapshot,
  ModelContextGeneration,
} from "@opencode-ai/sdk/v2"
import {
  harnessTargetIDs,
  instructionAdmissionStatus,
  instructionApplyState,
  instructionFileStatus,
  instructionPreview,
  reusableInstructionSources,
  type HarnessManagerModel,
} from "../../src/component/harness-manager"
import { completeLocalPath } from "../../src/component/location-directory-workflow"

const remote = "11111111-1111-4111-8111-111111111111"
const removed = "22222222-2222-4222-8222-222222222222"
const globalRead: HarnessInstructionRead = {
  scope: { type: "global" },
  mode: "custom",
  source: {
    reference: "policies/shared.md",
    resolved: "/controller/config/policies/shared.md",
    status: "readable",
    content: "bounded preview",
    size: 24_000,
    digest: "full-content-digest",
    truncated: true,
    sharedTargets: ["local", remote],
  },
  diagnostics: [],
}
const settings: HarnessInstructionSettingsSnapshot = {
  version: 1,
  path: "/controller/config/harness.jsonc",
  home: "/controller/home",
  revision: "0".repeat(64),
  targets: [
    { target: "local", reference: "policies/local.md" },
    { target: removed, reference: "policies/orphan.md" },
  ],
  diagnostics: [],
  valid: true,
}
const generation = {
  generation: 4,
  instructions: [
    {
      origin: "global-file",
      scope: "global",
      status: "loaded",
      content: "the complete policy body is longer than the preview",
      digest: "full-content-digest",
    },
    {
      origin: "target-file",
      scope: "target",
      status: "loaded",
      content: "local policy",
      digest: "local-digest",
    },
  ],
} as ModelContextGeneration

function targetRead(target: string, digest = `${target}-digest`): HarnessInstructionRead {
  return {
    scope: { type: "target", target },
    mode: "custom",
    source: {
      reference: `policies/${target}.md`,
      resolved: `/controller/config/policies/${target}.md`,
      status: "readable",
      content: "preview",
      size: 40_000,
      digest,
      truncated: true,
      sharedTargets: [target],
    },
    diagnostics: [],
  }
}

describe("harness manager", () => {
  test("uses full-content digests and compares only the current Session target", () => {
    expect(instructionFileStatus(globalRead)).toBe("● readable")
    expect(instructionAdmissionStatus(globalRead, generation, "local")).toBe("● applied")
    expect(
      instructionAdmissionStatus(
        { ...globalRead, source: { ...globalRead.source!, digest: "new-full-digest" } },
        generation,
        "local",
      ),
    ).toBe("! saved only")
    expect(instructionAdmissionStatus(targetRead("local", "local-digest"), generation, "local")).toBe("● applied")
    expect(instructionAdmissionStatus(targetRead(remote, "local-digest"), generation, "local")).toBe("○ other target")
    expect(instructionAdmissionStatus(targetRead(remote), undefined)).toBe("○ future")
  })

  test("includes configured orphan targets and deduplicates reusable shared files", () => {
    expect(harnessTargetIDs(settings, [{ id: remote, name: "cluster" }])).toEqual(["local", remote, removed])
    expect(
      reusableInstructionSources({
        global: globalRead,
        targets: {
          local: targetRead("local"),
          [remote]: { ...globalRead, scope: { type: "target", target: remote } },
        },
      }).map((source) => source.resolved),
    ).toEqual(["/controller/config/policies/local.md", "/controller/config/policies/shared.md"])
  })

  test("reports unavailable sources and busy Sessions before Apply", () => {
    const base: HarnessManagerModel = {
      settings,
      global: globalRead,
      targets: { local: targetRead("local", "local-digest") },
      definitions: [],
      admitted: generation,
      currentTarget: "local",
      applyStatus: { status: "ready", blockers: [] },
    }
    expect(instructionApplyState(base).footer).toBe("● ready")
    expect(
      instructionApplyState({
        ...base,
        applyStatus: { status: "busy", blockers: ["process_execution"] },
      }),
    ).toMatchObject({ footer: "! busy", detail: expect.stringContaining("process_execution") })
    expect(
      instructionApplyState({
        ...base,
        targets: {
          local: {
            ...base.targets.local!,
            source: { ...base.targets.local!.source!, status: "missing", content: undefined, digest: undefined },
          },
        },
      }).footer,
    ).toBe("! unavailable")
  })

  test("renders controller ownership, bounded preview state, and sharing targets", () => {
    const preview = instructionPreview("Global", globalRead, (target) =>
      target === "local" ? "local" : "shared-cluster",
    )

    expect(preview).toContain("Controller  /controller/config/policies/shared.md")
    expect(preview).toContain("Shared      local, shared-cluster")
    expect(preview).toContain("Preview (truncated)")
    expect(preview).toContain("bounded preview")
  })

  test("expands completion with controller HOME and keeps the filesystem request local", async () => {
    const calls: unknown[] = []
    const sdk = {
      client: {
        v2: {
          fs: {
            list: async (input: unknown) => {
              calls.push(input)
              return {
                data: {
                  data: [{ path: "/controller/home/policies", type: "directory" }],
                },
              }
            },
          },
        },
      },
    } as unknown as Parameters<typeof completeLocalPath>[0]["sdk"]

    expect(
      await completeLocalPath({
        sdk,
        home: "/controller/home",
        value: "~/pol",
        cursor: 5,
        cwd: "/controller/config",
        kind: "file",
      }),
    ).toMatchObject({ candidates: ["/controller/home/policies/"] })
    expect(calls).toEqual([{ location: { directory: "/controller/home" }, path: "." }])
  })
})

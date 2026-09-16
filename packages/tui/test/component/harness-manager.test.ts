import { describe, expect, test } from "bun:test"
import type { HarnessInstructionRead, HarnessInstructionSettingsSnapshot } from "@opencode-ai/sdk/v2"
import { harnessTargetIDs, instructionReference } from "../../src/component/harness-manager"
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
  test("includes configured orphan targets", () => {
    expect(harnessTargetIDs(settings, [{ id: remote, name: "cluster" }])).toEqual(["local", remote, removed])
  })

  test("renders configured, default global, and unset target references", () => {
    expect(instructionReference(settings, globalRead)).toBe("policies/shared.md")
    expect(
      instructionReference(settings, {
        scope: { type: "global" },
        mode: "default",
        diagnostics: [],
      }),
    ).toBe("/controller/config/AGENTS.md")
    expect(
      instructionReference(settings, {
        scope: { type: "target", target: remote },
        mode: "default",
        diagnostics: [],
      }),
    ).toBe("unset")
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

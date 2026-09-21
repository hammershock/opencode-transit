import { describe, expect, test } from "bun:test"
import {
  probeTargetHealth,
  targetHealthLabel,
  targetListPresentation,
  targetManagementActions,
  targetProbeGenerations,
} from "../../src/component/target-manager"
import { targetDescription } from "../../src/component/target-wizard"
import { targetInput } from "../../src/component/location-directory-workflow"

describe("target health presentation", () => {
  test("offers a direct description editor", () => {
    expect(targetManagementActions.map((action) => action.title)).toEqual([
      "Test connection",
      "Edit target",
      "Edit description",
      "Remove target",
    ])
  })

  test("preserves every target field while projecting a description update", () => {
    const target = {
      id: "target-1",
      name: "a100-2gpu",
      description: "Old description",
      transport: "ssh" as const,
      connection: { type: "manual" as const, host: "gpu.example", user: "hammer", port: 22 },
      workspaceRoots: ["/home/hammer"],
      defaultDirectory: "/home/hammer/project",
      command: { program: "/opt/rexd", args: ["serve", "--stdio"] },
      skillStagingRoot: "/home/hammer/.cache/opencode/skills",
    }
    expect(targetInput({ ...target, description: targetDescription("  New description  ").description })).toEqual({
      name: "a100-2gpu",
      description: "New description",
      transport: "ssh",
      connection: target.connection,
      workspaceRoots: ["/home/hammer"],
      defaultDirectory: "/home/hammer/project",
      command: target.command,
      skillStagingRoot: "/home/hammer/.cache/opencode/skills",
    })
    expect(targetInput({ ...target, description: targetDescription("   ").description })).not.toHaveProperty(
      "description",
    )
  })

  test("shows a description while falling back to the host", () => {
    const target = {
      id: "target-1",
      name: "a100-2gpu",
      description: "Huawei ModelArts 2×A100 GPU server",
      transport: "ssh" as const,
      connection: { type: "ssh-config" as const, host: "modelarts" },
      workspaceRoots: ["/home/ma-user/workspace"],
    }
    expect(targetListPresentation(target)).toEqual({
      description: "Huawei ModelArts 2×A100 GPU server",
    })
    expect(targetListPresentation({ ...target, description: undefined })).toEqual({
      description: "modelarts",
    })
  })

  test("trims wizard descriptions and omits blank values", () => {
    expect(targetDescription("  Huawei ModelArts 2×A100 GPU server  ")).toEqual({
      description: "Huawei ModelArts 2×A100 GPU server",
    })
    expect(targetDescription("   ")).toEqual({})
  })

  test("reserves the healthy symbol for ready targets", () => {
    expect(targetHealthLabel("checking")).toBe("◐ checking")
    expect(targetHealthLabel("ready")).toBe("● ready")
    expect(targetHealthLabel("unavailable")).toBe("! unavailable")
    expect(targetHealthLabel("invalid")).toBe("! invalid")
  })

  test("publishes a ready target without waiting for an offline peer", async () => {
    let releaseOffline!: () => void
    const offline = new Promise<void>((resolve) => {
      releaseOffline = resolve
    })
    const published: string[] = []

    const probing = probeTargetHealth(
      ["offline", "ready"],
      async (targetID) => {
        if (targetID === "offline") {
          await offline
          return { status: "unavailable" as const, stage: "ssh", message: "timed out" }
        }
        return { status: "ready" as const }
      },
      (targetID) => published.push(targetID),
    )

    await Bun.sleep(0)
    expect(published).toEqual(["ready"])
    releaseOffline()
    await probing
    expect(published).toEqual(["ready", "offline"])
  })

  test("a newer partial refresh does not discard unrelated target results", () => {
    const generations = targetProbeGenerations()
    const initial = generations.begin(["ready", "offline"])
    const retry = generations.begin(["offline"])

    expect(generations.accept("ready", initial)).toBe(true)
    expect(generations.accept("offline", initial)).toBe(false)
    expect(generations.accept("offline", retry)).toBe(true)
  })

  test("a synchronous SDK failure still publishes completion", async () => {
    const published: Array<[string, unknown]> = []
    await probeTargetHealth(
      ["broken"],
      () => {
        throw new TypeError("SDK method lost its receiver")
      },
      (targetID, result) => published.push([targetID, result]),
    )
    expect(published).toEqual([["broken", undefined]])
  })
})

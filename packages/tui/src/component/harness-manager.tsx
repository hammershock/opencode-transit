import path from "path"
import type {
  HarnessInstructionRead,
  HarnessInstructionSettingsSnapshot,
  HarnessInstructionSource,
  ModelContextGeneration,
} from "@opencode-ai/sdk/v2"
import { createMemo, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { DialogContentPreview } from "./dialog-model-context"
import { completeLocalPath } from "./location-directory-workflow"

const previewCommands = {
  namespace: "dialog.harness",
  lineUp: "dialog.harness.line_up",
  lineDown: "dialog.harness.line_down",
  pageUp: "dialog.harness.page_up",
  pageDown: "dialog.harness.page_down",
  home: "dialog.harness.home",
  end: "dialog.harness.end",
  copy: "dialog.harness.copy",
}

type Target = { readonly id: string; readonly name: string }
type Scope = { readonly type: "global" } | { readonly type: "target"; readonly target: string }
type Model = {
  readonly settings: HarnessInstructionSettingsSnapshot
  readonly global: HarnessInstructionRead
  readonly targets: Readonly<Record<string, HarnessInstructionRead>>
  readonly definitions: readonly Target[]
  readonly admitted?: ModelContextGeneration
}

export function instructionFileStatus(read: HarnessInstructionRead) {
  if (read.mode === "invalid") return "! invalid"
  if (!read.source) return "○ unset"
  if (read.source.status === "readable") return "● readable"
  return `! ${read.source.status}`
}

export function instructionAdmissionStatus(read: HarnessInstructionRead, admitted: ModelContextGeneration | undefined) {
  if (!admitted) return "○ future"
  const origin = read.scope.type === "global" ? "global-file" : "target-file"
  const current = admitted.instructions.find((item) => item.origin === origin)
  if (!read.source) return current ? "! saved only" : "● admitted"
  if (read.source.status !== "readable") return "! unavailable"
  if (current?.status === "loaded" && current.content === read.source.content) return "● admitted"
  return "! saved only"
}

export function instructionPreview(
  title: string,
  read: HarnessInstructionRead,
  targetName: (target: string) => string,
) {
  const source = read.source
  return [
    `Scope       ${title}`,
    `Selection   ${read.mode}`,
    `Reference   ${source?.reference ?? "(unset)"}`,
    `Controller  ${source?.resolved ?? "(none)"}`,
    `Status      ${source?.status ?? (read.mode === "invalid" ? "invalid" : "unset")}`,
    `Size        ${source?.size === undefined ? "(unknown)" : `${source.size} bytes`}`,
    `Shared      ${source?.sharedTargets.length ? source.sharedTargets.map(targetName).join(", ") : "none"}`,
    ...(source?.diagnostic ? [`Diagnostic  ${source.diagnostic}`] : []),
    ...read.diagnostics.map((diagnostic) => `Diagnostic  ${diagnostic.field}: ${diagnostic.message}`),
    "",
    source?.truncated ? "Preview (truncated)" : "Preview",
    source?.content ?? "(no readable content)",
  ].join("\n")
}

export function useHarnessManager(input: { readonly sessionID?: string; readonly openSkills: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [model, setModel] = createSignal<Model>()
  const [loading, setLoading] = createSignal(false)
  const [anchor, setAnchor] = createSignal<string>()
  const home = process.env.HOME ?? "~"

  const targetName = (target: string) => {
    if (target === "local") return "local"
    return model()?.definitions.find((item) => item.id === target)?.name ?? `missing:${target.slice(0, 8)}`
  }

  const read = async () => {
    const [settings, targets, admitted] = await Promise.all([
      sdk.client.v2.harness.instructions.settings({ throwOnError: true }),
      sdk.client.v2.target.list({ throwOnError: true }),
      input.sessionID
        ? sdk.client.v2.session
            .modelContext({ sessionID: input.sessionID }, { throwOnError: true })
            .then((result) => result.data.data ?? undefined)
        : Promise.resolve(undefined),
    ])
    const definitions = targets.data.targets.map((target) => ({ id: target.id, name: target.name }))
    const targetIDs = ["local", ...definitions.map((target) => target.id)]
    const [global, ...targetReads] = await Promise.all([
      sdk.client.v2.harness.instructions.global({ throwOnError: true }),
      ...targetIDs.map((target) => sdk.client.v2.harness.instructions.target({ target }, { throwOnError: true })),
    ])
    return {
      settings: settings.data,
      global: global.data,
      targets: Object.fromEntries(targetIDs.map((target, index) => [target, targetReads[index]!.data])),
      definitions,
      admitted,
    } satisfies Model
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await read()
      setModel(next)
      return next
    } catch (error) {
      toast.show({ title: "Harness settings unavailable", message: errorMessage(error), variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const save = async (operation: (current: Model) => Promise<unknown>, title: string) => {
    const current = model()
    if (!current) return
    setLoading(true)
    try {
      await operation(current)
      const next = await read()
      setModel(next)
      toast.show({
        title,
        message: input.sessionID
          ? "Saved for future admission · current Session unchanged"
          : "Saved for future admission",
        variant: "success",
      })
    } catch (error) {
      toast.show({ title: "Instruction settings not saved", message: errorMessage(error), variant: "error" })
      const latest = await read().catch(() => undefined)
      if (latest) setModel(latest)
    } finally {
      setLoading(false)
    }
  }

  const selectFile = async (scope: Scope, current?: HarnessInstructionSource) => {
    const snapshot = model()?.settings
    if (!snapshot) return
    const configDirectory = path.dirname(snapshot.path)
    const reference = await DialogPrompt.show(dialog, "Controller instruction file", {
      value: current?.reference,
      placeholder: path.join(configDirectory, "AGENTS.md"),
      description: () => <text>Controller filesystem file. Press Tab to browse local paths.</text>,
      complete: (value, cursor) =>
        completeLocalPath({ sdk, home, value, cursor, cwd: configDirectory, kind: "file" }).catch(() => ({
          value,
          cursor,
          candidates: [],
        })),
    })
    if (!reference?.trim()) return openInstructions(false)
    await save(
      (value) =>
        sdk.client.v2.harness.instructions.bind(
          {
            harnessInstructionBindInput: {
              scope,
              reference: reference.trim(),
              expectedRevision: value.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      scope.type === "global" ? "Global instruction saved" : `${targetName(scope.target)} instruction saved`,
    )
    openInstructions(false)
  }

  const resetGlobal = async () => {
    await save(
      (value) =>
        sdk.client.v2.harness.instructions.global2.reset(
          { harnessInstructionRevisionInput: { expectedRevision: value.settings.revision } },
          { throwOnError: true },
        ),
      "Global discovery reset",
    )
    openInstructions(false)
  }

  const unbind = async (target: string) => {
    await save(
      (value) =>
        sdk.client.v2.harness.instructions.target2.unbind(
          { harnessInstructionTargetMutationInput: { target, expectedRevision: value.settings.revision } },
          { throwOnError: true },
        ),
      `${targetName(target)} instruction unbound`,
    )
    openInstructions(false)
  }

  const preview = (title: string, read: HarnessInstructionRead) => {
    dialog.push(() => (
      <DialogContentPreview
        title={`Instructions · ${title}`}
        content={instructionPreview(title, read, targetName)}
        commands={previewCommands}
        copySuccess="Instruction preview copied to clipboard"
        copyFailure="Failed to copy instruction preview"
      />
    ))
  }

  const manage = (title: string, read: HarnessInstructionRead) => {
    setAnchor(read.scope.type === "global" ? "global" : `target:${read.scope.target}`)
    dialog.replace(() => (
      <DialogSelect
        title={`${title} · Controller instructions`}
        options={[
          {
            title: "Preview saved file",
            description: read.source ? `${read.source.status} · bounded controller-side preview` : "No file selected",
            value: "preview",
          },
          {
            title: read.source ? "Select another file…" : "Select file…",
            description: "Browse the controller filesystem",
            value: "select",
          },
          ...(read.scope.type === "global"
            ? [
                {
                  title: "Use default discovery",
                  description: "AGENTS.md, then CLAUDE.md fallback",
                  value: "clear",
                },
              ]
            : read.mode === "custom"
              ? [
                  {
                    title: "Unbind target",
                    description: "The shared file remains untouched",
                    value: "clear",
                  },
                ]
              : []),
        ]}
        onSelect={(option) => {
          if (option.value === "preview") return preview(title, read)
          if (option.value === "select") return void selectFile(read.scope, read.source)
          if (read.scope.type === "global") return void resetGlobal()
          return void unbind(read.scope.target)
        }}
      />
    ))
  }

  const apply = async () => {
    if (!input.sessionID || loading()) return
    setLoading(true)
    try {
      const result = await sdk.client.v2.session.instructions.apply(
        { sessionID: input.sessionID },
        { throwOnError: true },
      )
      const next = await read()
      setModel(next)
      toast.show({
        title: "Instructions applied",
        message: `Generation ${result.data.generation} · Location revision ${result.data.locationRevision}`,
        variant: "success",
      })
    } catch (error) {
      toast.show({ title: "Instructions not applied", message: errorMessage(error), variant: "error" })
    } finally {
      setLoading(false)
    }
    openInstructions(false)
  }

  const rows = createMemo(() => {
    const current = model()
    if (!current) return []
    const targets = [
      { id: "local", name: "local" },
      ...current.definitions,
      ...current.settings.targets
        .filter(
          (binding) => binding.target !== "local" && !current.definitions.some((item) => item.id === binding.target),
        )
        .map((binding) => ({ id: binding.target, name: `missing:${binding.target.slice(0, 8)}` })),
    ]
    return [
      ...(input.sessionID
        ? [
            {
              title: "Apply saved instructions",
              description: `Current Session only${current.admitted ? ` · generation ${current.admitted.generation}` : ""}`,
              footer: current.settings.valid ? "● ready" : "! invalid",
              value: "apply",
              category: "Actions",
            },
          ]
        : []),
      {
        title: "Global",
        description: current.global.source?.reference ?? "Default AGENTS.md / CLAUDE.md discovery",
        footer: `${instructionFileStatus(current.global)} · ${instructionAdmissionStatus(current.global, current.admitted)}`,
        value: "global",
        category: "Instructions · Controller filesystem",
      },
      ...targets.map((target) => {
        const value = current.targets[target.id]!
        return {
          title: target.name,
          description: value.source?.reference ?? "No target rule",
          footer: `${instructionFileStatus(value)} · ${instructionAdmissionStatus(value, current.admitted)}`,
          value: `target:${target.id}`,
          category: "Targets · Controller filesystem",
          details: value.source?.sharedTargets.length
            ? [`Shared by ${value.source.sharedTargets.map(targetName).join(", ")}`]
            : undefined,
        }
      }),
      ...current.settings.diagnostics.map((diagnostic, index) => ({
        title: diagnostic.field,
        description: diagnostic.message,
        footer: `! ${diagnostic.kind}`,
        value: `diagnostic:${index}`,
        category: "Diagnostics",
      })),
    ] satisfies DialogSelectOption<string>[]
  })

  function openInstructions(load = true) {
    dialog.replace(() => (
      <DialogSelect
        title="Harness instructions · Controller filesystem"
        locked={loading()}
        preserveSelection
        current={anchor()}
        options={rows()}
        emptyView={<text>{loading() ? "Loading controller instruction settings…" : "No settings available"}</text>}
        footer={
          model() ? (
            <text>
              {input.sessionID
                ? "Save affects future admission · Apply updates this Session"
                : "Save affects future admission"}
            </text>
          ) : undefined
        }
        onSelect={(option) => {
          if (option.value === "apply") return void apply()
          if (option.value === "global") return manage("Global", model()!.global)
          if (!option.value.startsWith("target:")) return
          const target = option.value.slice(7)
          manage(targetName(target), model()!.targets[target]!)
        }}
      />
    ))
    dialog.setSize("xlarge")
    if (load) void refresh()
  }

  function open(view: "menu" | "instructions" | "skills" = "menu") {
    if (view === "instructions") return openInstructions()
    if (view === "skills") return input.openSkills()
    dialog.replace(() => (
      <DialogSelect
        title="Harness"
        options={[
          {
            title: "Instructions",
            description: "Controller global and target rule files",
            value: "instructions" as const,
          },
          {
            title: "Skills",
            description: "Existing discovery and target access manager",
            value: "skills" as const,
          },
        ]}
        onSelect={(option) => open(option.value)}
      />
    ))
  }

  return { open, refresh, model }
}

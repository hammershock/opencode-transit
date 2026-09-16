import path from "path"
import type {
  HarnessInstructionRead,
  HarnessInstructionSettingsSnapshot,
  HarnessInstructionSource,
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
export type HarnessManagerModel = {
  readonly settings: HarnessInstructionSettingsSnapshot
  readonly global: HarnessInstructionRead
  readonly targets: Readonly<Record<string, HarnessInstructionRead>>
  readonly definitions: readonly Target[]
}

export function harnessTargetIDs(settings: HarnessInstructionSettingsSnapshot, definitions: readonly Target[]) {
  return [
    ...new Set(["local", ...definitions.map((target) => target.id), ...settings.targets.map((item) => item.target)]),
  ]
}

export function instructionReference(settings: HarnessInstructionSettingsSnapshot, read: HarnessInstructionRead) {
  if (read.source) return read.source.reference
  if (read.scope.type === "target") return "unset"
  return path.join(path.dirname(settings.path), "AGENTS.md")
}

export function useHarnessManager(input: { readonly openSkills: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [model, setModel] = createSignal<HarnessManagerModel>()
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  let generation = 0

  const targetName = (target: string) => {
    if (target === "local") return "local"
    return model()?.definitions.find((item) => item.id === target)?.name ?? `Removed target ${target.slice(0, 8)}`
  }

  const read = async () => {
    const [settings, targets] = await Promise.all([
      sdk.client.v2.harness.instructions.settings({ throwOnError: true }),
      sdk.client.v2.target.list({ throwOnError: true }),
    ])
    const definitions = targets.data.targets.map((target) => ({ id: target.id, name: target.name }))
    const targetIDs = harnessTargetIDs(settings.data, definitions)
    const [global, ...targetReads] = await Promise.all([
      sdk.client.v2.harness.instructions.global({ throwOnError: true }),
      ...targetIDs.map((target) => sdk.client.v2.harness.instructions.target({ target }, { throwOnError: true })),
    ])
    return {
      settings: settings.data,
      global: global.data,
      targets: Object.fromEntries(targetIDs.map((target, index) => [target, targetReads[index]!.data])),
      definitions,
    } satisfies HarnessManagerModel
  }

  const refresh = async (token = generation) => {
    if (token !== generation) return
    setLoading(true)
    setLoadError(undefined)
    try {
      const next = await read()
      if (token !== generation) return
      setModel(next)
      return next
    } catch (error) {
      if (token !== generation) return
      const message = errorMessage(error)
      setLoadError(message)
      toast.show({ title: "Harness settings unavailable", message, variant: "error" })
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  const save = async (operation: (current: HarnessManagerModel) => Promise<unknown>, title: string) => {
    const current = model()
    if (!current || loading()) return false
    const token = generation
    setLoading(true)
    try {
      await operation(current)
    } catch (error) {
      if (token === generation) {
        setLoading(false)
        toast.show({ title: "Instruction path not saved", message: errorMessage(error), variant: "error" })
      }
      return false
    }
    if (token !== generation) return false
    setLoading(false)
    await refresh(token)
    if (token !== generation) return false
    toast.show({ title, message: "Saved for future Sessions", variant: "success" })
    return true
  }

  const bind = (scope: Scope, reference: string) =>
    save(
      (value) =>
        sdk.client.v2.harness.instructions.bind(
          {
            harnessInstructionBindInput: {
              scope,
              reference,
              expectedRevision: value.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      scope.type === "global" ? "Global path saved" : `${targetName(scope.target)} path saved`,
    )

  const promptControllerFile = (current?: HarnessInstructionSource) =>
    new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (value: string | null, close = true) => {
        if (settled) return
        settled = true
        resolve(value)
        if (close) dialog.pop()
      }
      const snapshot = model()!.settings
      const configDirectory = path.dirname(snapshot.path)
      dialog.push(
        () => (
          <DialogPrompt
            title="Controller instruction file"
            value={current?.reference}
            placeholder={path.join(configDirectory, "AGENTS.md")}
            description={() => <text>Relative to {configDirectory} · Tab completes</text>}
            complete={(value, cursor) => {
              if ((value === "~" || value.startsWith("~/")) && !snapshot.home)
                return Promise.resolve({
                  value,
                  cursor,
                  candidates: [],
                  error: "Controller HOME is unavailable; use a relative or absolute controller path.",
                })
              return completeLocalPath({
                sdk,
                home: snapshot.home ?? configDirectory,
                value,
                cursor,
                cwd: configDirectory,
                kind: "file",
              }).catch((error) => ({
                value,
                cursor,
                candidates: [],
                error: `Cannot browse the controller folder. Check its path and read access, then press Tab to retry. ${errorMessage(error)}`,
              }))
            }}
            onConfirm={(value) => finish(value)}
            onCancel={() => finish(null)}
          />
        ),
        () => finish(null, false),
      )
    })

  const selectFile = async (read: HarnessInstructionRead) => {
    const reference = await promptControllerFile(read.source)
    if (!reference?.trim()) return
    await bind(read.scope, reference.trim())
  }

  const clear = async (read: HarnessInstructionRead) => {
    if (read.scope.type === "global") {
      if (read.mode !== "custom") return
      await save(
        (value) =>
          sdk.client.v2.harness.instructions.global2.reset(
            { harnessInstructionRevisionInput: { expectedRevision: value.settings.revision } },
            { throwOnError: true },
          ),
        "Global path reset",
      )
      return
    }
    if (read.mode !== "custom") return
    const target = read.scope.target
    await save(
      (value) =>
        sdk.client.v2.harness.instructions.target2.unbind(
          {
            harnessInstructionTargetMutationInput: {
              target,
              expectedRevision: value.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      `${targetName(target)} path unset`,
    )
  }

  const selectedRead = (option?: DialogSelectOption<string>) => {
    const current = model()
    if (!current || !option) return
    if (option.value === "global") return current.global
    if (!option.value.startsWith("target:")) return
    return current.targets[option.value.slice(7)]
  }

  const preview = (read: HarnessInstructionRead) => {
    const source = read.source
    const content = source?.content
    if (content === undefined) {
      toast.show({
        title: "Preview unavailable",
        message: source?.diagnostic ?? "No readable document is selected.",
        variant: "warning",
      })
      return
    }
    dialog.push(() => (
      <DialogContentPreview
        title={`Instructions · ${read.scope.type === "global" ? "Global" : targetName(read.scope.target)}`}
        content={`${content || "(empty instruction file)"}${source?.truncated ? "\n\n[preview truncated]" : ""}`}
        commands={previewCommands}
        copySuccess="Instruction preview copied to clipboard"
        copyFailure="Failed to copy instruction preview"
      />
    ))
  }

  const rows = createMemo(() => {
    const current = model()
    if (!current) {
      const error = loadError()
      return error
        ? ([
            { title: "Retry loading", description: error, value: "retry", category: "Error" },
          ] satisfies DialogSelectOption<string>[])
        : []
    }
    const targets = harnessTargetIDs(current.settings, current.definitions).map((id) => ({
      id,
      name: id === "local" ? "local" : targetName(id),
    }))
    const width = Math.min(28, Math.max("Global rule".length, ...targets.map((target) => target.name.length)))
    return [
      {
        title: "Global rule".padEnd(width),
        description: instructionReference(current.settings, current.global),
        value: "global",
        category: "Global",
      },
      ...targets.map((target) => ({
        title: target.name.padEnd(width),
        description: instructionReference(current.settings, current.targets[target.id]!),
        value: `target:${target.id}`,
        category: "Target",
      })),
    ] satisfies DialogSelectOption<string>[]
  })

  function instructionsView() {
    return (
      <DialogSelect
        title="Harness instructions · Controller"
        locked={loading()}
        preserveSelection
        renderFilter={false}
        options={rows()}
        emptyView={<text>Loading instruction paths…</text>}
        footerHints={[{ title: "enter", label: "edit" }]}
        actions={[
          {
            command: "dialog.harness.unset",
            title: "unset",
            disabled: (option) => selectedRead(option)?.mode !== "custom",
            onTrigger: (option) => {
              const read = selectedRead(option)
              if (read) void clear(read)
            },
          },
          {
            command: "dialog.harness.preview",
            title: "preview",
            side: "right",
            disabled: (option) => selectedRead(option)?.source?.content === undefined,
            onTrigger: (option) => {
              const read = selectedRead(option)
              if (read) preview(read)
            },
          },
        ]}
        onSelect={(option) => {
          if (option.value === "retry") return void refresh()
          const read = selectedRead(option)
          if (read) void selectFile(read)
        }}
      />
    )
  }

  function openInstructions() {
    const token = generation
    dialog.push(instructionsView, () => {
      if (generation !== token) return
      generation++
      setLoading(false)
    })
    dialog.setSize("xlarge")
    void refresh(token)
  }

  function menuView() {
    return (
      <DialogSelect
        title="Harness"
        options={[
          { title: "Instructions", value: "instructions" as const },
          { title: "Skills", value: "skills" as const },
        ]}
        onSelect={(option) => {
          if (option.value === "instructions") return openInstructions()
          input.openSkills()
        }}
      />
    )
  }

  function open(view: "menu" | "instructions" | "skills" = "menu") {
    const token = ++generation
    setModel(undefined)
    setLoadError(undefined)
    setLoading(false)
    dialog.replace(menuView, () => {
      if (generation === token) generation++
    })
    if (view === "instructions") return openInstructions()
    if (view === "skills") return input.openSkills()
  }

  return { open, refresh, model }
}

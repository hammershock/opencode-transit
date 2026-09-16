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
type ApplyStatus = {
  readonly status: "ready" | "busy" | "unresolved"
  readonly blockers: readonly string[]
}
export type HarnessManagerModel = {
  readonly settings: HarnessInstructionSettingsSnapshot
  readonly global: HarnessInstructionRead
  readonly targets: Readonly<Record<string, HarnessInstructionRead>>
  readonly definitions: readonly Target[]
  readonly admitted?: ModelContextGeneration
  readonly currentTarget?: string
  readonly applyStatus?: ApplyStatus
  readonly applyDiagnostic?: string
}

export function instructionFileStatus(read: HarnessInstructionRead) {
  if (read.mode === "invalid") return "! invalid"
  if (!read.source) return "○ unset"
  if (read.source.status === "readable") return "● readable"
  return `! ${read.source.status}`
}

export function instructionAdmissionStatus(
  read: HarnessInstructionRead,
  admitted: ModelContextGeneration | undefined,
  currentTarget?: string,
) {
  if (read.scope.type === "target" && !currentTarget) return "○ future"
  if (read.scope.type === "target" && read.scope.target !== currentTarget) return "○ other target"
  if (!admitted) return "○ future"
  const origin = read.scope.type === "global" ? "global-file" : "target-file"
  const current = admitted.instructions.find((item) => item.origin === origin)
  if (!read.source) return current ? "! saved only" : "● applied"
  if (read.source.status !== "readable") return "! unavailable"
  if (!read.source.digest || !current?.digest) return "◐ compare unavailable"
  if (current.status === "loaded" && current.digest === read.source.digest) return "● applied"
  return "! saved only"
}

export function harnessTargetIDs(settings: HarnessInstructionSettingsSnapshot, definitions: readonly Target[]) {
  return [
    ...new Set(["local", ...definitions.map((target) => target.id), ...settings.targets.map((item) => item.target)]),
  ]
}

export function reusableInstructionSources(model: Pick<HarnessManagerModel, "global" | "targets">) {
  return [
    ...new Map(
      [model.global, ...Object.values(model.targets)]
        .filter((read) => read.mode === "custom" && read.source)
        .map((read) => [read.source!.resolved, read.source!] as const),
    ).values(),
  ].toSorted((left, right) => left.reference.localeCompare(right.reference))
}

export function instructionApplyState(model: HarnessManagerModel) {
  if (!model.settings.valid) return { footer: "! invalid", detail: "Fix harness settings diagnostics, then retry." }
  if (!model.admitted) return { footer: "! unavailable", detail: "This Session has no admitted context to replace." }
  if (model.applyDiagnostic) return { footer: "! unavailable", detail: `${model.applyDiagnostic} Retry status.` }
  if (!model.applyStatus) return { footer: "◐ checking", detail: "Checking whether this Session is idle." }
  if (model.applyStatus.status === "unresolved")
    return { footer: "! unresolved", detail: "Recover this Session Location, then retry." }
  if (model.applyStatus.status === "busy")
    return {
      footer: "! busy",
      detail: `Wait for Session activity to finish, then retry (${model.applyStatus.blockers.join(", ")}).`,
    }
  const selected = [model.global, ...(model.currentTarget ? [model.targets[model.currentTarget]] : [])].filter(
    (read): read is HarnessInstructionRead => read !== undefined,
  )
  const unavailable = selected.find(
    (read) => read.mode === "invalid" || (read.source !== undefined && read.source.status !== "readable"),
  )
  if (unavailable)
    return {
      footer: "! unavailable",
      detail: "A selected controller instruction file is unavailable. Fix it, refresh, then retry.",
    }
  return { footer: "● ready", detail: "Applies without invoking the model or editing project files." }
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
  const [model, setModel] = createSignal<HarnessManagerModel>()
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  const [anchor, setAnchor] = createSignal<string>()
  let generation = 0

  const targetName = (target: string) => {
    if (target === "local") return "local"
    return model()?.definitions.find((item) => item.id === target)?.name ?? `Removed target ${target.slice(0, 8)}`
  }

  const read = async () => {
    const [settings, targets, session, admitted, apply] = await Promise.all([
      sdk.client.v2.harness.instructions.settings({ throwOnError: true }),
      sdk.client.v2.target.list({ throwOnError: true }),
      input.sessionID
        ? sdk.client.v2.session
            .get({ sessionID: input.sessionID }, { throwOnError: true })
            .then((result) => result.data.data)
        : Promise.resolve(undefined),
      input.sessionID
        ? sdk.client.v2.session
            .modelContext({ sessionID: input.sessionID }, { throwOnError: true })
            .then((result) => result.data.data ?? undefined)
        : Promise.resolve(undefined),
      input.sessionID
        ? sdk.client.v2.session.instructions
            .status({ sessionID: input.sessionID }, { throwOnError: true })
            .then((result) => ({ status: result.data, diagnostic: undefined }))
            .catch((error) => ({ status: undefined, diagnostic: errorMessage(error) }))
        : Promise.resolve({ status: undefined, diagnostic: undefined }),
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
      admitted,
      currentTarget: session
        ? session.location.target?.type === "rexd"
          ? session.location.target.targetID
          : "local"
        : undefined,
      applyStatus: apply.status,
      applyDiagnostic: apply.diagnostic,
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
        toast.show({ title: "Instruction settings not saved", message: errorMessage(error), variant: "error" })
      }
      return false
    }
    if (token !== generation) return false
    setLoading(false)
    await refresh(token)
    if (token !== generation) return false
    toast.show({
      title,
      message: input.sessionID ? "Saved · current Session unchanged until Apply" : "Saved for future Sessions",
      variant: "success",
    })
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
      scope.type === "global" ? "Global instruction saved" : `${targetName(scope.target)} instruction saved`,
    )

  const promptControllerFile = (current?: HarnessInstructionSource) =>
    new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        resolve(value)
        dialog.pop()
      }
      const snapshot = model()!.settings
      const configDirectory = path.dirname(snapshot.path)
      dialog.push(
        () => (
          <DialogPrompt
            title="Controller instruction file"
            value={current?.reference}
            placeholder={path.join(configDirectory, "AGENTS.md")}
            description={() => <text>Controller file · relative to {configDirectory} · Tab completes</text>}
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
              }).catch((error) => ({ value, cursor, candidates: [], error: errorMessage(error) }))
            }}
            onConfirm={(value) => finish(value)}
            onCancel={() => finish(null)}
          />
        ),
        () => finish(null),
      )
    })

  const selectFile = async (scope: Scope, current?: HarnessInstructionSource) => {
    const reference = await promptControllerFile(current)
    if (!reference?.trim()) return
    if (await bind(scope, reference.trim())) dialog.pop()
  }

  const resetGlobal = async () => {
    const saved = await save(
      (value) =>
        sdk.client.v2.harness.instructions.global2.reset(
          { harnessInstructionRevisionInput: { expectedRevision: value.settings.revision } },
          { throwOnError: true },
        ),
      "Global discovery reset",
    )
    if (saved) dialog.pop()
  }

  const unbind = async (target: string) => {
    const saved = await save(
      (value) =>
        sdk.client.v2.harness.instructions.target2.unbind(
          { harnessInstructionTargetMutationInput: { target, expectedRevision: value.settings.revision } },
          { throwOnError: true },
        ),
      `${targetName(target)} instruction unbound`,
    )
    if (saved) dialog.pop()
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

  const reuse = (scope: Extract<Scope, { type: "target" }>, current?: HarnessInstructionSource) => {
    const options = reusableInstructionSources(model()!)
      .filter((source) => source.resolved !== current?.resolved)
      .map((source) => ({
        title: path.basename(source.reference),
        description: source.reference,
        footer: source.status === "readable" ? "● readable" : `! ${source.status}`,
        details: source.sharedTargets.length
          ? [`Used by ${source.sharedTargets.map(targetName).join(", ")}`]
          : ["Global custom file"],
        value: source.reference,
      }))
    dialog.push(() => (
      <DialogSelect
        title="Reuse controller instruction file"
        current={options[0]?.value}
        options={[
          {
            title: "Back to target",
            description: "Keep the current binding",
            value: "__back",
            category: "Navigation",
          },
          ...options.map((option) => ({ ...option, category: "Already bound" })),
        ]}
        onSelect={(option) => {
          if (option.value === "__back") return dialog.pop()
          void bind(scope, option.value).then((saved) => {
            if (!saved) return
            dialog.pop()
            dialog.pop()
          })
        }}
      />
    ))
  }

  const manage = (title: string, read: HarnessInstructionRead) => {
    setAnchor(read.scope.type === "global" ? "global" : `target:${read.scope.target}`)
    const shared =
      read.scope.type === "target"
        ? reusableInstructionSources(model()!).filter((source) => source.resolved !== read.source?.resolved)
        : []
    dialog.push(() => (
      <DialogSelect
        title={`${title} · Controller file`}
        footer={<text>Precedence: Global → this target → Location project</text>}
        options={[
          {
            title: "Back to Instructions",
            description: "Keep the current selection",
            value: "back",
            category: "Navigation",
          },
          {
            title: "Preview",
            description: read.source ? `${read.source.reference} · bounded controller preview` : "No file selected",
            footer: instructionFileStatus(read),
            value: "preview",
            category: "File",
          },
          {
            title: read.source ? "Select another file…" : "Select file…",
            description: "Browse the controller filesystem",
            value: "select",
            category: "File",
          },
          ...(read.scope.type === "target" && shared.length
            ? [
                {
                  title: "Reuse bound file…",
                  description: `${shared.length} controller ${shared.length === 1 ? "file" : "files"} available`,
                  value: "reuse",
                  category: "File",
                },
              ]
            : []),
          ...(read.scope.type === "global"
            ? [
                {
                  title: "Use default discovery",
                  description: "Controller AGENTS.md, then CLAUDE.md fallback",
                  value: "clear",
                  category: "Binding",
                },
              ]
            : read.mode === "custom"
              ? [
                  {
                    title: "Unbind target",
                    description: "Keep the shared rule file",
                    value: "clear",
                    category: "Binding",
                  },
                ]
              : []),
        ]}
        onSelect={(option) => {
          if (option.value === "back") return dialog.pop()
          if (option.value === "preview") return preview(title, read)
          if (option.value === "select") return void selectFile(read.scope, read.source)
          if (option.value === "reuse" && read.scope.type === "target") return reuse(read.scope, read.source)
          if (read.scope.type === "global") return void resetGlobal()
          return void unbind(read.scope.target)
        }}
      />
    ))
  }

  const apply = async () => {
    if (!input.sessionID || loading()) return
    const token = generation
    setAnchor("apply")
    setLoading(true)
    try {
      const result = await sdk.client.v2.session.instructions.apply(
        { sessionID: input.sessionID },
        { throwOnError: true },
      )
      if (token !== generation) return
      setLoading(false)
      await refresh(token)
      if (token !== generation) return
      toast.show({
        title: "Instructions applied",
        message: `Applied to this Session · generation ${result.data.generation}`,
        variant: "success",
      })
    } catch (error) {
      if (token !== generation) return
      setLoading(false)
      await refresh(token)
      if (token !== generation) return
      toast.show({
        title: "Instructions not applied",
        message: `${errorMessage(error)} Nothing changed; resolve the issue and retry.`,
        variant: "error",
      })
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  const rows = createMemo(() => {
    const current = model()
    const navigation = {
      title: "Back to Harness",
      description: "Instructions and Skills",
      value: "back",
      category: "Navigation",
    }
    if (!current)
      return [
        navigation,
        ...(loadError()
          ? [
              {
                title: "Retry loading",
                description: loadError(),
                footer: "! unavailable",
                value: "refresh",
                category: "Actions",
              },
            ]
          : []),
      ] satisfies DialogSelectOption<string>[]
    const targets = harnessTargetIDs(current.settings, current.definitions).map((id) => ({
      id,
      name: id === "local" ? "local" : targetName(id),
    }))
    const applyState = instructionApplyState(current)
    return [
      navigation,
      ...(input.sessionID
        ? [
            {
              title: "Apply to this Session",
              description: current.admitted
                ? `Saved vs generation ${current.admitted.generation}`
                : "No admitted generation",
              footer: loading() ? "◐ checking" : applyState.footer,
              details: [applyState.detail],
              value: "apply",
              category: "Current Session",
            },
            {
              title: "Refresh status",
              description: "Reread controller files and Session readiness",
              footer: loading() ? "◐ checking" : "",
              value: "refresh",
              category: "Current Session",
            },
          ]
        : []),
      {
        title: "Global",
        description: current.global.source?.reference ?? "Default AGENTS.md / CLAUDE.md discovery",
        footer: `${instructionFileStatus(current.global)} · ${instructionAdmissionStatus(current.global, current.admitted, current.currentTarget)}`,
        value: "global",
        category: "Controller files",
      },
      ...targets.map((target) => {
        const value = current.targets[target.id]!
        const isCurrent = target.id === current.currentTarget
        return {
          title: target.name,
          description: value.source?.reference ?? "No target rule",
          footer: `${isCurrent ? "current · " : ""}${instructionFileStatus(value)} · ${instructionAdmissionStatus(value, current.admitted, current.currentTarget)}`,
          value: `target:${target.id}`,
          category: "Target files · Controller",
          details: [
            ...(isCurrent ? ["Current Session target"] : []),
            ...(target.name.startsWith("Removed target")
              ? ["Target was removed; its binding can still be unbound."]
              : []),
            ...(value.source?.sharedTargets.length
              ? [`Shared by ${value.source.sharedTargets.map(targetName).join(", ")}`]
              : []),
          ],
        }
      }),
      ...current.settings.diagnostics.map((diagnostic, index) => ({
        title: diagnostic.field,
        description: diagnostic.message,
        footer: `! ${diagnostic.kind}`,
        value: `diagnostic:${index}`,
        category: "Diagnostics",
      })),
      ...(loadError()
        ? [
            {
              title: "Retry loading",
              description: loadError(),
              footer: "! unavailable",
              value: "refresh",
              category: "Diagnostics",
            },
          ]
        : []),
    ] satisfies DialogSelectOption<string>[]
  })

  function instructionsView() {
    return (
      <DialogSelect
        title="Harness instructions · Controller"
        locked={loading()}
        preserveSelection
        current={anchor()}
        options={rows()}
        footer={<text>Precedence: Global → current target → Location project · Save ≠ Apply</text>}
        onSelect={(option) => {
          if (option.value === "back") return dialog.pop()
          if (option.value === "refresh") return void refresh()
          if (option.value === "apply") return void apply()
          if (option.value === "global") return manage("Global", model()!.global)
          if (!option.value.startsWith("target:")) return
          const target = option.value.slice(7)
          const value = model()!.targets[target]
          if (!value) return void refresh()
          manage(targetName(target), value)
        }}
      />
    )
  }

  function openInstructions() {
    dialog.push(instructionsView)
    dialog.setSize("xlarge")
    void refresh()
  }

  function menuView() {
    return (
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

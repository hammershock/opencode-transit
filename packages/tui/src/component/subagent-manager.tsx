import type {
  SubagentDefinitionDraft,
  SubagentEntry,
  SubagentPermissionConfig,
  SubagentSnapshot,
} from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { isDeepEqual } from "remeda"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import {
  DialogSelect,
  displayTruncate,
  inspectionFrame,
  type DialogSelectOption,
  type DialogSelectRef,
} from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type LocationQuery = { directory: string; workspace?: string; target?: string }
type CapabilityProfile = "read-only" | "write" | "full-access" | "custom"

const profiles = {
  "read-only": {
    label: "Read only",
    description: "Read, search and web; no writes, shell mutation or delegation",
    permission: {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      webfetch: "allow",
      websearch: "allow",
      task: "deny",
    },
  },
  write: {
    label: "Write",
    description: "Workspace read/write; shell asks; no delegation",
    permission: {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      edit: "allow",
      bash: "ask",
      webfetch: "allow",
      websearch: "allow",
      task: "deny",
    },
  },
  "full-access": {
    label: "Full access",
    description: "Regular execution tools; Session and Location limits still apply",
    permission: { "*": "allow" },
  },
} as const satisfies Record<
  Exclude<CapabilityProfile, "custom">,
  {
    label: string
    description: string
    permission: SubagentPermissionConfig
  }
>

export function subagentProfile(permission: SubagentPermissionConfig | undefined): CapabilityProfile {
  if (isDeepEqual(permission, profiles["read-only"].permission)) return "read-only"
  if (isDeepEqual(permission, profiles.write.permission)) return "write"
  if (isDeepEqual(permission, profiles["full-access"].permission)) return "full-access"
  return "custom"
}

export function subagentCapability(entry: Pick<SubagentEntry, "permission" | "capabilities">) {
  const profile = subagentProfile(entry.permission)
  if (profile !== "custom") return profiles[profile].label
  if (entry.capabilities.includes("read-only")) return "Read only"
  if (entry.capabilities.includes("full-access")) return "Full access"
  if (entry.capabilities.includes("workspace-write")) return "Write"
  return "Custom"
}

export function parseSubagentPermission(value: string): SubagentPermissionConfig {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Permissions must be a JSON object")
  const result: SubagentPermissionConfig = {}
  for (const [permission, rule] of Object.entries(parsed)) {
    if (rule === "ask" || rule === "allow" || rule === "deny") {
      result[permission] = rule
      continue
    }
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`Invalid rule for ${permission}`)
    const patterns: Record<string, "ask" | "allow" | "deny"> = {}
    for (const [pattern, action] of Object.entries(rule)) {
      if (action !== "ask" && action !== "allow" && action !== "deny")
        throw new Error(`Invalid action for ${permission}:${pattern}`)
      patterns[pattern] = action
    }
    result[permission] = patterns
  }
  return result
}

export function subagentColumnWidths(terminalWidth: number) {
  const available = Math.max(48, Math.min(108, terminalWidth - 10))
  const state = 2
  const capability = 12
  const model = Math.max(16, Math.min(30, Math.floor(available * 0.28)))
  const name = Math.max(12, Math.min(24, Math.floor(available * 0.2)))
  return {
    state,
    name,
    model,
    capability,
    description: Math.max(12, available - state - name - model - capability - 4),
  }
}

export function subagentRow(entry: SubagentEntry, terminalWidth: number) {
  const presentation = subagentPresentation(entry, terminalWidth)
  return `${presentation.prefix}${column(presentation.description, presentation.descriptionWidth)}`
}

function subagentPresentation(entry: SubagentEntry, terminalWidth: number) {
  const widths = subagentColumnWidths(terminalWidth)
  const state = entry.effective === "active" ? "●" : "○"
  const model = entry.model ? `${entry.model.providerID}/${entry.model.modelID}` : "inherit"
  const suffix = [entry.editable ? undefined : "read only", entry.approvalRequired ? "approval" : undefined]
    .filter(Boolean)
    .join(" · ")
  const description = [entry.description, suffix].filter(Boolean).join(" · ")
  return {
    prefix: `${[
      column(state, widths.state),
      column(entry.name, widths.name),
      column(model, widths.model),
      column(subagentCapability(entry), widths.capability),
    ].join(" ")} `,
    description,
    descriptionWidth: widths.description,
  }
}

export function useSubagentManager(input: {
  sessionID: () => string
  parentAgentID: () => string
  location: () => LocationQuery | undefined
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [snapshot, setSnapshot] = createSignal<SubagentSnapshot>()
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  let generation = 0
  let selectRef: DialogSelectRef<string> | undefined

  const read = async () => {
    const result = await sdk.client.v2.subagent.catalog(
      {
        location: input.location(),
        sessionID: input.sessionID(),
        parentAgentID: input.parentAgentID(),
        includeInactive: "true",
      },
      { throwOnError: true },
    )
    return result.data.data
  }

  const refresh = async (token = generation) => {
    if (token !== generation) return
    setLoading(true)
    setLoadError(undefined)
    try {
      const next = await read()
      if (token !== generation) return
      setSnapshot(next)
    } catch (error) {
      if (token !== generation) return
      const message = errorMessage(error)
      setLoadError(message)
      toast.show({ title: "Subagents unavailable", message, variant: "error" })
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  const mutate = async (operation: (current: SubagentSnapshot) => Promise<SubagentSnapshot>) => {
    const current = snapshot()
    if (!current || loading()) return false
    const token = generation
    setLoading(true)
    try {
      const next = await operation(current)
      if (token !== generation) return false
      setSnapshot(next)
      return true
    } catch (error) {
      if (token !== generation) return false
      toast.show({ title: "Subagent change not saved", message: errorMessage(error), variant: "error" })
      const latest = await read().catch(() => undefined)
      if (latest && token === generation) setSnapshot(latest)
      return false
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  const context = (current: SubagentSnapshot) => ({
    sessionID: input.sessionID(),
    parentAgentID: current.parentAgentID,
    expectedRevision: current.revision,
  })

  const setAccess = async (entry: SubagentEntry, scope: "session" | "global") => {
    const active = entry.effective !== "active"
    const saved = await mutate(async (current) => {
      const result = await sdk.client.v2.subagent.access.update(
        {
          location: input.location(),
          subagentAccessUpdate: { ...context(current), subagentID: entry.id, active, scope },
        },
        { throwOnError: true },
      )
      return result.data.data
    })
    if (saved) dialog.pop()
  }

  const scope = (entry: SubagentEntry) => {
    const verb = entry.effective === "active" ? "Deactivate" : "Activate"
    dialog.push(() => (
      <DialogSelect
        title={`${verb} · ${entry.name}`}
        locked={loading()}
        renderFilter={false}
        options={[
          { title: "This session", description: "Override only the current Session", value: "session" as const },
          {
            title: "Globally",
            description: "Set the default and clear this Session override",
            value: "global" as const,
          },
        ]}
        onSelect={(option) => void setAccess(entry, option.value)}
      />
    ))
  }

  const updateDraft = (
    setDraft: (
      value: SubagentDefinitionDraft | ((current: SubagentDefinitionDraft) => SubagentDefinitionDraft),
    ) => void,
    field: keyof SubagentDefinitionDraft,
    value: SubagentDefinitionDraft[keyof SubagentDefinitionDraft],
  ) => setDraft((current) => ({ ...current, [field]: value || undefined }))

  const textField = (
    setDraft: (
      value: SubagentDefinitionDraft | ((current: SubagentDefinitionDraft) => SubagentDefinitionDraft),
    ) => void,
    field: keyof SubagentDefinitionDraft,
    title: string,
    value?: string,
    placeholder?: string,
  ) =>
    dialog.push(() => (
      <DialogPrompt
        title={title}
        value={value}
        placeholder={placeholder}
        onConfirm={(next) => {
          updateDraft(setDraft, field, next.trim())
          dialog.pop()
        }}
      />
    ))

  const modelField = (
    setDraft: (
      value: SubagentDefinitionDraft | ((current: SubagentDefinitionDraft) => SubagentDefinitionDraft),
    ) => void,
    current?: string,
  ) => {
    const options = [
      { title: "Inherit", description: "Use the parent or configured default", value: "" },
      ...sync.data.provider.flatMap((provider) =>
        Object.values(provider.models)
          .filter((model) => model.status !== "deprecated")
          .map((model) => ({
            title: model.name ?? model.id,
            description: provider.name,
            value: `${provider.id}/${model.id}`,
            category: provider.name,
          })),
      ),
    ]
    dialog.push(() => (
      <DialogSelect
        title="Model"
        current={current ?? ""}
        options={options}
        onSelect={(option) => {
          updateDraft(setDraft, "model", option.value)
          dialog.pop()
        }}
      />
    ))
    dialog.setSize("xlarge")
  }

  const capabilityField = (
    setDraft: (
      value: SubagentDefinitionDraft | ((current: SubagentDefinitionDraft) => SubagentDefinitionDraft),
    ) => void,
    setProfile: (value: CapabilityProfile) => void,
    current: CapabilityProfile,
  ) => {
    const options: DialogSelectOption<CapabilityProfile>[] = [
      ...(["read-only", "write", "full-access"] as const).map((value) => ({
        title: profiles[value].label,
        description: profiles[value].description,
        value,
      })),
      { title: "Custom", description: "Preserve or edit permission rules", value: "custom" },
    ]
    dialog.push(() => (
      <DialogSelect
        title="Capability"
        current={current}
        renderFilter={false}
        options={options}
        onSelect={(option) => {
          setProfile(option.value)
          if (option.value !== "custom") updateDraft(setDraft, "permission", profiles[option.value].permission)
          dialog.pop()
        }}
      />
    ))
  }

  const permissionField = (
    setDraft: (
      value: SubagentDefinitionDraft | ((current: SubagentDefinitionDraft) => SubagentDefinitionDraft),
    ) => void,
    current?: SubagentPermissionConfig,
  ) =>
    dialog.push(() => (
      <DialogPrompt
        title="Custom permissions"
        value={JSON.stringify(current ?? {}, null, 2)}
        placeholder='{"read":"allow","edit":"deny"}'
        onConfirm={(value) => {
          try {
            updateDraft(setDraft, "permission", parseSubagentPermission(value))
            dialog.pop()
          } catch (error) {
            toast.show({ title: "Invalid permissions", message: errorMessage(error), variant: "warning" })
          }
        }}
      />
    ))

  const saveDefinition = async (entry: SubagentEntry | undefined, definition: SubagentDefinitionDraft) => {
    if (!definition.name.trim()) {
      toast.show({ message: "Name is required", variant: "warning" })
      return
    }
    const saved = await mutate(async (current) => {
      const common = { location: input.location() }
      if (entry) {
        const result = await sdk.client.v2.subagent.definition.update(
          {
            ...common,
            subagentID: entry.id,
            subagentDefinitionUpdatePayload: { ...context(current), definition },
          },
          { throwOnError: true },
        )
        return result.data.data
      }
      const result = await sdk.client.v2.subagent.definition.create(
        {
          ...common,
          subagentDefinitionCreate: { ...context(current), definition },
        },
        { throwOnError: true },
      )
      return result.data.data
    })
    if (!saved) return
    const id = entry?.id ?? snapshot()?.entries.find((item) => item.name === definition.name)?.id
    dialog.pop()
    if (id) requestAnimationFrame(() => selectRef?.moveTo(id))
  }

  const editor = (entry?: SubagentEntry) => {
    const [draft, setDraft] = createSignal<SubagentDefinitionDraft>({
      name: entry?.name ?? "",
      model: entry?.model ? `${entry.model.providerID}/${entry.model.modelID}` : undefined,
      variant: entry?.variant,
      description: entry?.description,
      prompt: entry?.prompt,
      steps: entry?.steps,
      permission: entry?.permission,
    })
    const [profile, setProfile] = createSignal(subagentProfile(entry?.permission))
    const options = createMemo<DialogSelectOption<string>[]>(() => [
      { title: "Name", description: draft().name || "Required", value: "name" },
      { title: "Model", description: draft().model || "Inherit", value: "model" },
      { title: "Variant", description: draft().variant || "Default", value: "variant" },
      { title: "Description", description: short(draft().description), value: "description" },
      { title: "Instructions", description: short(draft().prompt), value: "prompt" },
      { title: "Steps", description: draft().steps ? String(draft().steps) : "Default", value: "steps" },
      {
        title: "Capability",
        description: profileLabel(profile()),
        value: "capability",
      },
      ...(profile() === "custom" ? [{ title: "Permissions", description: "JSON rules", value: "permission" }] : []),
      { title: loading() ? "Saving…" : "Save", value: "save", category: "" },
    ])
    const select = (field: string) => {
      if (field === "name") return textField(setDraft, "name", "Name", draft().name, "reviewer")
      if (field === "model") return modelField(setDraft, draft().model)
      if (field === "variant") return textField(setDraft, "variant", "Variant", draft().variant, "default")
      if (field === "description")
        return textField(setDraft, "description", "Description", draft().description, "Short purpose")
      if (field === "prompt") return textField(setDraft, "prompt", "Instructions", draft().prompt, "Agent instructions")
      if (field === "steps") {
        return dialog.push(() => (
          <DialogPrompt
            title="Step limit"
            value={draft().steps ? String(draft().steps) : undefined}
            placeholder="Default"
            onConfirm={(value) => {
              const steps = value.trim() ? Number(value) : undefined
              if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) {
                toast.show({ message: "Steps must be a positive integer", variant: "warning" })
                return
              }
              updateDraft(setDraft, "steps", steps)
              dialog.pop()
            }}
          />
        ))
      }
      if (field === "capability") return capabilityField(setDraft, setProfile, profile())
      if (field === "permission") return permissionField(setDraft, draft().permission)
      if (field === "save") return void saveDefinition(entry, draft())
    }
    dialog.push(() => (
      <DialogSelect
        title={`${entry ? "Edit" : "Add"} subagent`}
        locked={loading()}
        preserveSelection
        renderFilter={false}
        options={options()}
        footer={<text fg={theme.textMuted}>ctrl+s save · esc cancel</text>}
        actions={[
          {
            command: "dialog.subagent.save",
            title: "Save",
            onTrigger: () => void saveDefinition(entry, draft()),
          },
        ]}
        onSelect={(option) => select(option.value)}
      />
    ))
    dialog.setSize("xlarge")
  }

  const remove = (entry: SubagentEntry) => {
    const label = entry.source === "builtin" ? "Disable" : "Delete"
    dialog.push(() => (
      <DialogSelect
        title={`${label} · ${entry.name}`}
        renderFilter={false}
        locked={loading()}
        options={[
          {
            title: label,
            description: entry.source === "builtin" ? "Disable this built-in globally" : "Move to managed trash",
            value: "remove",
          },
          { title: "Cancel", value: "cancel" },
        ]}
        onSelect={(option) => {
          if (option.value === "cancel") return dialog.pop()
          void mutate(async (current) => {
            const result = await sdk.client.v2.subagent.definition.remove(
              {
                location: input.location(),
                subagentID: entry.id,
                subagentMutationContext: context(current),
              },
              { throwOnError: true },
            )
            return result.data.data
          }).then((saved) => {
            if (saved) dialog.pop()
          })
        }}
      />
    ))
  }

  const rows = createMemo(() => snapshot()?.entries ?? [])
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    rows().map((entry) => {
      const presentation = subagentPresentation(entry, dimensions().width)
      const title = subagentRow(entry, dimensions().width)
      return {
        title,
        titleWidth: Bun.stringWidth(title),
        inspectionTitle: `${presentation.prefix}${presentation.description}`,
        inspectionView: (offset, width) => (
          <>
            {presentation.prefix}
            {inspectionFrame(
              presentation.description,
              Math.max(0, width - Bun.stringWidth(presentation.prefix)),
              offset,
            )}
          </>
        ),
        inspectTitle: true,
        value: entry.id,
      }
    }),
  )

  const selectedEntry = (option?: DialogSelectOption<string>) =>
    option ? snapshot()?.entries.find((entry) => entry.id === option.value) : undefined

  function view() {
    const current = snapshot()
    return (
      <DialogSelect
        title={`Subagents · ${current?.parentAgentID ?? input.parentAgentID()}`}
        titleView={
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Subagents · {current?.parentAgentID ?? input.parentAgentID()}
          </text>
        }
        locked={loading()}
        preserveSelection
        ref={(value) => (selectRef = value)}
        renderFilter={false}
        options={options()}
        emptyView={
          <text>
            {loading() ? "Loading subagents…" : loadError() ? "Unable to load subagents" : "No subagents available"}
          </text>
        }
        footer={
          current ? (
            <text fg={theme.textMuted}>
              {current.entries.filter((entry) => entry.effective === "active").length}/{current.entries.length} active
              {current.diagnostics.length ? ` · ${current.diagnostics.length} diagnostics` : ""}
            </text>
          ) : undefined
        }
        footerHints={[
          { title: "enter", label: "edit" },
          { title: "space", label: "toggle" },
        ]}
        actions={[
          { command: "dialog.subagent.add", title: "Add", onTrigger: () => editor() },
          {
            command: "dialog.subagent.delete",
            title: "Delete",
            disabled: (option) => !selectedEntry(option)?.editable,
            onTrigger: (option) => {
              const entry = selectedEntry(option)
              if (entry) remove(entry)
            },
          },
        ]}
        onToggle={(option) => {
          const entry = selectedEntry(option)
          if (!entry) return
          scope(entry)
        }}
        onSelect={(option) => {
          const entry = selectedEntry(option)
          if (!entry) return
          if (entry.editable) return editor(entry)
          toast.show({ message: `${entry.name} is read only`, variant: "warning" })
        }}
      />
    )
  }

  function open() {
    const token = ++generation
    setSnapshot(undefined)
    setLoadError(undefined)
    setLoading(false)
    dialog.replace(view, () => {
      if (generation === token) generation++
    })
    dialog.setSize("xlarge")
    void refresh(token)
  }

  return { open, refresh, snapshot }
}

function short(value: string | undefined) {
  if (!value) return "Not set"
  return value.replace(/\s+/g, " ").slice(0, 80)
}

function profileLabel(profile: CapabilityProfile) {
  if (profile === "custom") return "Custom"
  return profiles[profile].label
}

function column(value: string, width: number) {
  const visible = displayTruncate(value, width)
  return visible + " ".repeat(Math.max(0, width - Bun.stringWidth(visible)))
}

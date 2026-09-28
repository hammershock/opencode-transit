import path from "path"
import type {
  SkillDiscoveryRoot,
  SkillDetail,
  SkillMetadata,
  SkillRegistrySnapshot,
  SkillSettingsSnapshot,
  SkillTargetScope,
} from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, displayTruncate, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { DialogContentPreview } from "./dialog-model-context"
import { completeLocalDirectory } from "./location-directory-workflow"

const skillPreviewCommands = {
  namespace: "dialog.skill",
  lineUp: "dialog.skill.line_up",
  lineDown: "dialog.skill.line_down",
  pageUp: "dialog.skill.page_up",
  pageDown: "dialog.skill.page_down",
  home: "dialog.skill.home",
  end: "dialog.skill.end",
  copy: "dialog.skill.copy",
}

type SkillManagerTarget = { readonly id: string; readonly name: string }

type SkillManagerModel = {
  readonly settings: SkillSettingsSnapshot
  readonly catalog: SkillRegistrySnapshot
  readonly targets: readonly SkillManagerTarget[]
  readonly catalogError?: string
  readonly targetError?: string
}

type ManagerRow = {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly footer?: string
  readonly details?: string[]
  readonly category: string
  readonly inspectTitle?: boolean
  readonly inspectionTitle?: string
  readonly skill?: {
    readonly source: string
    readonly targets: string
    readonly state: "active" | "inactive"
  }
}

export function skillRootStatus(root: SkillDiscoveryRoot) {
  if (root.status === "undetected") return "! undetected"
  if (root.status === "unavailable") return "! unavailable"
  if (root.default) return "● default"
  if (root.status === "configured") return "○ configured"
  return "● ready"
}

export function skillScopeLabel(scope: SkillTargetScope | undefined) {
  if (scope === undefined || scope === "*") return "all"
  if (scope.length === 0) return "none"
  return scope.join(", ")
}

export function toggleSkillTargetScope(
  scope: SkillTargetScope,
  target: "local" | string,
  targets: readonly string[] = [target],
): SkillTargetScope {
  if (scope === "*") return targets.filter((item) => item !== target)
  if (scope.includes(target)) return scope.filter((item) => item !== target)
  return [...scope, target]
}

export function skillSourceLabel(sourceLabel: string) {
  const source = sourceLabel.replace(/ · [0-9a-f]{8}$/i, "").toLowerCase()
  if (source === "built-in" || source.startsWith("opencode ") || source.startsWith("project .opencode"))
    return "opencode"
  if (source === "codex") return "codex"
  if (source === "claude") return "claude"
  return "others"
}

export function skillTargetsLabel(scope: SkillTargetScope | undefined, targets: readonly SkillManagerTarget[]) {
  if (scope === undefined || scope === "*") return "all"
  if (scope.length === 0) return "none"
  return scope
    .map((targetID) => {
      if (targetID === "local") return "local"
      return targets.find((target) => target.id === targetID)?.name ?? `missing:${targetID.slice(0, 8)}`
    })
    .join(", ")
}

export function buildSkillManagerRows(model: SkillManagerModel): ManagerRow[] {
  const duplicateNames = new Set(
    model.catalog.skills
      .filter((skill, index, skills) =>
        skills.some((item, itemIndex) => itemIndex !== index && item.name === skill.name),
      )
      .map((skill) => skill.name),
  )
  return [
    ...model.catalog.skills
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((skill) => {
        const scope = targetScope(model.settings, skill.id)
        return {
          key: `skill:${skill.id}`,
          title: skill.name,
          details: duplicateNames.has(skill.name) ? ["Duplicate name · source identity is preserved"] : undefined,
          category: "Skills",
          skill: {
            source: skillSourceLabel(skill.sourceLabel),
            targets: skillTargetsLabel(scope, model.targets),
            state: scope === "*" || scope.length > 0 ? ("active" as const) : ("inactive" as const),
          },
        }
      }),
  ]
}

export function useSkillManager() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [model, setModel] = createSignal<SkillManagerModel>()
  const [loading, setLoading] = createSignal(false)
  const [anchor, setAnchor] = createSignal<string>()
  const home = process.env.HOME

  const read = async (force: boolean) => {
    const settings = await sdk.client.v2.skill.settings({ throwOnError: true })
    const location = { directory: path.dirname(settings.data.path) }
    const [catalog, targets] = await Promise.allSettled([
      sdk.client.v2.skill.catalog(
        { location, forceReload: force ? "true" : "false", includeInactive: "true" },
        { throwOnError: true },
      ),
      sdk.client.v2.target.list({ throwOnError: true }),
    ])
    return {
      settings: settings.data,
      catalog:
        catalog.status === "fulfilled"
          ? catalog.value.data.data
          : ({ revision: "", digest: "", skills: [], diagnostics: [] } satisfies SkillRegistrySnapshot),
      targets:
        targets.status === "fulfilled"
          ? targets.value.data.targets.map((target) => ({ id: target.id, name: target.name }))
          : [],
      ...(catalog.status === "rejected" ? { catalogError: errorMessage(catalog.reason) } : {}),
      ...(targets.status === "rejected" ? { targetError: errorMessage(targets.reason) } : {}),
    } satisfies SkillManagerModel
  }

  const refresh = async (force = false) => {
    const previous = model()?.catalog.digest
    setLoading(true)
    try {
      const next = await read(force)
      setModel(next)
      if (next.catalogError)
        toast.show({ title: "Skill catalog unavailable", message: next.catalogError, variant: "warning" })
      if (next.targetError) toast.show({ title: "Targets unavailable", message: next.targetError, variant: "warning" })
      if (force)
        toast.show({
          title: previous && previous !== next.catalog.digest ? "Skill catalog changed" : "Skill catalog unchanged",
          message: `${next.catalog.skills.length} Skills · ${next.catalog.diagnostics.length + next.settings.diagnostics.length} diagnostics`,
          variant: next.catalogError ? "warning" : "success",
        })
      return next
    } catch (error) {
      toast.show({ title: "Skill settings unavailable", message: errorMessage(error), variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const save = async (operation: (current: SkillManagerModel) => Promise<unknown>, title: string, rescan = false) => {
    const current = model()
    if (!current || loading()) return
    setLoading(true)
    try {
      await operation(current)
      const next = await read(rescan)
      setModel(next)
      toast.show({
        title,
        message: next.catalogError ?? "Saved locally · /context reload updates an open Session",
        variant: next.catalogError ? "warning" : "success",
      })
    } catch (error) {
      toast.show({ title: "Skill settings not saved", message: errorMessage(error), variant: "error" })
      const latest = await read(false).catch(() => undefined)
      if (latest) setModel(latest)
    } finally {
      setLoading(false)
    }
  }

  const editPath = async (root?: SkillDiscoveryRoot) => {
    const current = model()
    if (!current || loading() || root?.default || root?.kind === "url") return
    const configDirectory = path.dirname(current.settings.path)
    const value = await new Promise<string | null>((resolve) => {
      dialog.push(
        () => (
          <DialogPrompt
            title={root ? "Edit Skill path" : "Add Skill path"}
            value={root?.value}
            placeholder={configDirectory}
            description={() => (
              <text>Local discovery directory. Tab completes paths; files are never moved or deleted.</text>
            )}
            complete={(value, cursor) =>
              completeLocalDirectory({ sdk, home: home ?? "~", value, cursor, cwd: configDirectory })
            }
            onConfirm={(value) => {
              resolve(value)
              dialog.pop()
            }}
            onCancel={() => dialog.pop()}
          />
        ),
        () => {
          resolve(null)
          dialog.setSize("xlarge")
        },
      )
      dialog.setSize("large")
    })
    if (!value?.trim() || value.trim() === root?.value) return
    await save(
      () =>
        sdk.client.v2.skill.discovery.update(
          {
            skillDiscoveryUpdate: {
              paths: root
                ? importedPaths(current.settings).map((item) => (item === root.value ? value.trim() : item))
                : [...importedPaths(current.settings), value.trim()],
              urls: configuredUrls(current.settings),
              expectedRevision: current.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      root ? "Discovery path updated" : "Discovery path added",
      true,
    )
  }

  const removeRoot = async (root: SkillDiscoveryRoot) => {
    if (root.default) return
    await save(
      (current) =>
        sdk.client.v2.skill.discovery.update(
          {
            skillDiscoveryUpdate: {
              paths: importedPaths(current.settings).filter((value) => root.kind === "url" || value !== root.value),
              urls: configuredUrls(current.settings).filter((value) => root.kind !== "url" || value !== root.value),
              expectedRevision: current.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      "Discovery path removed",
      true,
    )
  }

  const openPaths = () => {
    dialog.push(() => (
      <DialogSelect<string>
        title="Skill paths · local"
        locked={loading()}
        preserveSelection
        options={model() ? buildSkillPathRows(model()!.settings, home, dimensions().width) : []}
        emptyView={<text>No discovery paths configured</text>}
        footer={<text>enter edit · paths only</text>}
        actions={[
          {
            command: "dialog.skill.path_add",
            title: "add",
            requiresSelection: false,
            onTrigger: () => void editPath(),
          },
          {
            command: "dialog.skill.path_remove",
            title: "remove",
            disabled: (option) =>
              !option || Boolean(model()?.settings.roots.find((root) => rootKey(root) === option.value)?.default),
            onTrigger: (option) => {
              const root = model()?.settings.roots.find((root) => rootKey(root) === option.value)
              if (root) void removeRoot(root)
            },
          },
          {
            command: "dialog.skill.reload",
            title: "reload",
            requiresSelection: false,
            onTrigger: () => void refresh(true),
          },
        ]}
        onSelect={(option) => void editPath(model()?.settings.roots.find((root) => rootKey(root) === option.value))}
      />
    ))
    dialog.setSize("xlarge")
  }

  const showTargetAccess = (skill: SkillMetadata) => {
    const current = model()
    if (!current) return
    const [scope, setScope] = createSignal(targetScope(current.settings, skill.id))
    const missing = createMemo(() => {
      const value = scope()
      if (value === "*") return []
      return value.filter(
        (target) => target !== "local" && !current.targets.some((configured) => configured.id === target),
      )
    })
    const targetIDs = ["local", ...current.targets.map((target) => target.id)]
    const toggle = (value: string) => {
      if (value === "all") return setScope((current) => (current === "*" ? [] : "*"))
      setScope((current) => toggleSkillTargetScope(current, value.slice(7), targetIDs))
    }
    const apply = () => {
      if (loading()) return
      void save(
        (snapshot) =>
          sdk.client.v2.skill.targetScope.update(
            {
              skillID: skill.id,
              skillTargetScopeUpdate: { scope: scope(), expectedRevision: snapshot.settings.revision },
            },
            { throwOnError: true },
          ),
        "Target access saved",
      ).then(() => open(false))
    }
    const options = createMemo(() => [
      {
        title: `${scope() === "*" ? "[x]" : "[ ]"} all`,
        description: "Includes future targets",
        value: "all",
        category: "Targets",
        onSelect: () => toggle("all"),
      },
      targetOption("local", "local", scope(), toggle),
      ...current.targets.map((target) => targetOption(target.id, target.name, scope(), toggle)),
      ...missing().map((targetID) => ({
        title: `${scope() !== "*" && scope().includes(targetID) ? "[x]" : "[ ]"} missing:${targetID.slice(0, 8)}`,
        description: "The stable target ID is preserved",
        value: `target:${targetID}`,
        category: "Targets",
        onSelect: () => toggle(`target:${targetID}`),
      })),
    ])
    const Content = () => (
      <DialogSelect<string>
        title={`Target access · ${skill.name}`}
        options={options()}
        renderFilter={false}
        preserveSelection
        locked={loading()}
        footer={<TargetAccessFooter onConfirm={apply} />}
        onToggle={(option) => toggle(option.value)}
        onConfirm={apply}
      />
    )
    dialog.replace(Content)
    dialog.setSize("large")
  }

  const showSkillPreview = async (key: string) => {
    const current = model()
    if (!current || !key.startsWith("skill:")) return
    const skillID = key.slice(6)
    if (!current.catalog.skills.some((skill) => skill.id === skillID)) return
    setAnchor(key)
    setLoading(true)
    try {
      const result = await sdk.client.v2.skill.get(
        { skillID, location: { directory: path.dirname(current.settings.path) } },
        { throwOnError: true },
      )
      dialog.push(() => (
        <DialogContentPreview
          title={`Skill · ${result.data.data.metadata.name}`}
          content={skillPreviewContent(result.data.data, home)}
          commands={skillPreviewCommands}
          copySuccess="Skill content copied to clipboard"
          copyFailure="Failed to copy Skill content"
        />
      ))
    } catch (error) {
      toast.show({ title: "Skill content unavailable", message: errorMessage(error), variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const rows = createMemo(() => (model() ? buildSkillManagerRows(model()!) : []))
  const skillTitle = (name: string, skill: NonNullable<ManagerRow["skill"]>) => {
    const widths = skillColumnWidths(dimensions().width)
    return `${column(name, widths.name)} ${column(skill.source, widths.source)} ${column(skill.targets, widths.targets)}`
  }
  const skillHeader = () => {
    const widths = skillColumnWidths(dimensions().width)
    return (
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        {column("Name", widths.name)} {column("Source", widths.source)} {column("Targets", widths.targets)} State
      </text>
    )
  }
  const options = createMemo(() =>
    rows().map((row): DialogSelectOption<string> => {
      const skill = row.skill
      return {
        title: skill ? skillTitle(row.title, skill) : row.title,
        titleWidth: skill ? skillTitleWidth(dimensions().width) : undefined,
        description: row.description,
        footer: skill
          ? () => (
              <span
                style={{
                  fg: skill.state === "active" ? theme.success : theme.textMuted,
                }}
              >
                {skillStateLabel(skill.state)}
              </span>
            )
          : row.footer,
        footerWidth: skill ? 12 : undefined,
        details: row.details,
        category: row.category,
        categoryView:
          skill && rows().find((item) => item.category === "Skills")?.key === row.key ? () => skillHeader() : undefined,
        inspectTitle: row.inspectTitle,
        inspectionTitle: row.inspectionTitle,
        value: row.key,
      }
    }),
  )

  const select = (key: string) => {
    const current = model()
    if (!current) return
    if (!key.startsWith("skill:")) return
    const skillID = key.slice(6)
    const skill = current.catalog.skills.find((item) => item.id === skillID)
    if (!skill) return
    showTargetAccess(skill)
  }

  function open(load = true) {
    // DialogSelect owns navigation state. A controlled current/onMove pair recenters after
    // every key repeat and makes long Skill catalogs jump between queued scroll positions.
    dialog.replace(() => (
      <DialogSelect
        title="Manage skills"
        locked={loading()}
        preserveSelection
        current={anchor()}
        options={options()}
        emptyView={
          <text>
            {loading() ? "Loading local Skill settings…" : "No Skills discovered · open paths to manage discovery"}
          </text>
        }
        footer={
          model() ? (
            <text>
              {model()!.settings.roots.length} paths · {model()!.catalog.skills.length} Skills ·{" "}
              {model()!.settings.diagnostics.length +
                model()!.catalog.diagnostics.length +
                Number(Boolean(model()!.catalogError)) +
                Number(Boolean(model()!.targetError))}{" "}
              diagnostics
            </text>
          ) : undefined
        }
        actions={[
          { command: "dialog.skill.paths", title: "paths", requiresSelection: false, onTrigger: openPaths },
          {
            command: "dialog.skill.reload",
            title: "reload",
            requiresSelection: false,
            onTrigger: () => void refresh(true),
          },
          {
            command: "dialog.skill.preview",
            title: "View",
            disabled: (option) =>
              !option?.value.startsWith("skill:") ||
              !model()?.catalog.skills.some((skill) => `skill:${skill.id}` === option.value),
            onTrigger: (option) => void showSkillPreview(option.value),
          },
        ]}
        onSelect={(option) => select(option.value)}
      />
    ))
    dialog.setSize("xlarge")
    if (load) void refresh()
  }

  return { open, refresh, model }
}

export function buildSkillPathRows(
  settings: SkillSettingsSnapshot,
  home?: string,
  width = 100,
): DialogSelectOption<string>[] {
  let imported = 0
  return settings.roots.map((root) => {
    const field = root.kind === "imported" ? `skills.paths.${imported++}` : root.value
    return {
      title: rootTitle(root, home),
      value: rootKey(root),
      category: root.default ? "Defaults" : root.kind === "url" ? "URL sources" : "Imported paths",
      titleWidth: Math.max(12, Math.min(104, width - 14) - 16),
      footer: skillRootStatus(root),
      footerWidth: 14,
      inspectTitle: true,
      inspectionTitle: root.value,
      details: settings.diagnostics.filter((item) => item.field === field).map((item) => item.message),
    }
  })
}

export function skillPreviewContent(detail: SkillDetail, home?: string) {
  const location =
    home && (detail.location === home || detail.location.startsWith(home + path.sep))
      ? detail.location === home
        ? "~"
        : `~${detail.location.slice(home.length)}`
      : detail.location
  return [
    `Name         ${detail.metadata.name}`,
    `Description  ${detail.metadata.description ?? "(none)"}`,
    `Source       ${detail.metadata.sourceLabel}`,
    `Entry        ${location}`,
    `Digest       ${detail.metadata.digest}`,
    "",
    "SKILL.md",
    detail.content || "(empty SKILL.md body)",
  ].join("\n")
}

function rootKey(root: SkillDiscoveryRoot) {
  return `${root.kind}:${root.value}`
}

function rootTitle(root: SkillDiscoveryRoot, home?: string) {
  if (root.default) return `OpenCode config · ${path.basename(root.value)}`
  if (!home || (root.value !== home && !root.value.startsWith(home + path.sep))) return root.value
  return root.value === home ? "~" : `~${root.value.slice(home.length)}`
}

function targetScope(settings: SkillSettingsSnapshot, skillID: string): SkillTargetScope {
  const value = settings.targets[skillID]
  if (value === "*") return value
  if (Array.isArray(value) && value.every((target) => typeof target === "string")) return value
  return "*"
}

function importedPaths(settings: SkillSettingsSnapshot) {
  return settings.roots.filter((root) => root.kind === "imported").map((root) => root.value)
}

function configuredUrls(settings: SkillSettingsSnapshot) {
  return settings.roots.filter((root) => root.kind === "url").map((root) => root.value)
}

function targetOption(targetID: string, name: string, scope: SkillTargetScope, toggle: (value: string) => void) {
  const value = `target:${targetID}`
  return {
    title: `${scope === "*" || scope.includes(targetID) ? "[x]" : "[ ]"} ${name}`,
    description: targetID === "local" ? "This controller" : "Configured Rexd target",
    value,
    category: "Targets",
    onSelect: () => toggle(value),
  }
}

function TargetAccessFooter(props: { onConfirm: () => void }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} onMouseUp={props.onConfirm}>
      <span style={{ fg: theme.text }}>[ Confirm ]</span> enter · space toggle
    </text>
  )
}

function skillStateLabel(state: "active" | "inactive") {
  if (state === "active") return "● active"
  return "○ inactive"
}

function skillColumnWidths(terminalWidth: number) {
  const available = Math.max(46, Math.min(104, terminalWidth - 14))
  const source = 10
  const state = 12
  const targets = Math.max(14, Math.min(36, Math.floor((available - source - state - 3) * 0.45)))
  return { name: Math.max(10, available - source - targets - state - 3), source, targets }
}

function skillTitleWidth(terminalWidth: number) {
  const widths = skillColumnWidths(terminalWidth)
  return widths.name + widths.source + widths.targets + 2
}

function column(value: string, width: number) {
  const visible = displayTruncate(value, width)
  return visible + " ".repeat(Math.max(0, width - Bun.stringWidth(visible)))
}

export type { ManagerRow, SkillManagerModel, SkillManagerTarget }

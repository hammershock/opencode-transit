import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import type { ModelContextGeneration } from "../command-toolkit/model-context"
import { useTuiConfig } from "../config"
import { useClipboard } from "../context/clipboard"
import { useTheme } from "../context/theme"
import { formatKeyBindings, useBindings, useKeymapSelector } from "../keymap"
import { getScrollAcceleration } from "../util/scroll"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type Preview = { title: string; content: string }

type ContentPreviewCommands = {
  readonly namespace: string
  readonly lineUp: string
  readonly lineDown: string
  readonly pageUp: string
  readonly pageDown: string
  readonly home: string
  readonly end: string
  readonly copy: string
}

const modelContextCommands = {
  namespace: "dialog.model_context",
  lineUp: "dialog.model_context.line_up",
  lineDown: "dialog.model_context.line_down",
  pageUp: "dialog.model_context.page_up",
  pageDown: "dialog.model_context.page_down",
  home: "dialog.model_context.home",
  end: "dialog.model_context.end",
  copy: "dialog.model_context.copy",
} satisfies ContentPreviewCommands
const scopeOrder = { global: 0, target: 1, project: 2, nested: 3 } as const

function instructionTitle(scope: "global" | "target" | "project" | "nested") {
  if (scope === "global") return "global-instructions"
  if (scope === "nested") return "  project-instructions"
  return "target-instructions"
}

function renderConversationCheckpoint(compaction: { summary: string; recent: string }) {
  return `<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\n${compaction.summary}\n</summary>\n\n<recent-context>\n${compaction.recent}\n</recent-context>\n</conversation-checkpoint>`
}

export function modelContextOptions(
  generation: ModelContextGeneration,
  footerWidth: number,
): DialogSelectOption<Preview>[] {
  const environment = generation.environment
  const sources = generation.sources
  const options: DialogSelectOption<Preview>[] = []

  if (generation.model) {
    options.push({
      category: "Request",
      title: "model",
      footer: `${generation.model.providerID}/${generation.model.id}${generation.model.variant ? ` ${generation.model.variant}` : ""}`,
      value: { title: "model", content: JSON.stringify(generation.model, null, 2) },
    })
  }
  if (generation.headers) {
    const entries = Object.entries(generation.headers)
    options.push({
      category: "Request",
      title: "headers",
      footer: `${entries.length} header${entries.length === 1 ? "" : "s"}`,
      value: { title: "headers", content: entries.map(([name, value]) => `${name}: ${value}`).join("\n") },
    })
  }

  const agentSystem = generation.agentSystem ?? ""
  options.push({
    category: "SystemPrompt",
    title: "agent-system-prompt",
    footer: `${agentSystem.length}chars`,
    value: {
      title: "agent-system-prompt",
      content: generation.agentSystem ?? "The agent base system prompt is unavailable for this Session.",
    },
  })

  const environmentSource = sources["core/environment"]
  if (environmentSource) {
    options.push({
      category: "SystemPrompt",
      title: "environment",
      footer: environment.targetName,
      value: {
        title: "environment",
        content: environmentSource.baseline ?? JSON.stringify(environment, null, 2),
      },
    })
  }

  const dateSource = sources["core/date"]
  if (dateSource) {
    const date = (dateSource.value as { date?: string } | undefined)?.date ?? ""
    options.push({
      category: "SystemPrompt",
      title: "date",
      footer: date,
      value: { title: "date", content: dateSource.baseline ?? JSON.stringify(dateSource.value, null, 2) },
    })
  }

  const instructions = [...generation.instructions].sort(
    (a, b) => scopeOrder[a.scope] - scopeOrder[b.scope],
  )
  for (const instruction of instructions) {
    options.push({
      category: "SystemPrompt",
      title: instructionTitle(instruction.scope),
      footer: instruction.source,
      value: {
        title: instruction.source,
        content:
          instruction.status === "ignored"
            ? `Ignored during ${instruction.failureStage ?? "load"}.`
            : instruction.content || "(empty instruction file)",
      },
    })
  }

  for (const [key, source] of Object.entries(sources)) {
    if (key === "core/environment" || key === "core/date" || key === "core/instructions") continue
    options.push({
      category: "SystemPrompt",
      title: key,
      value: { title: key, content: source.baseline ?? JSON.stringify(source.value, null, 2) },
    })
  }

  if (generation.runtimeParts) {
    const skillCount = generation.skillCatalog?.skills.length ?? generation.runtimeParts.length
    options.push({
      category: "SystemPrompt",
      title: "available_skills",
      footer: `${skillCount}`,
      value: { title: "available_skills", content: generation.runtimeParts.map((part) => part.text).join("\n\n") },
    })
  }

  if (generation.subagentRefresh) {
    const catalog = generation.subagentCatalog
    options.push({
      category: "SystemPrompt",
      title: "available_subagents",
      footer: generation.subagentRefresh.status === "disabled" ? "None" : `${catalog?.agents.length ?? 0}`,
      value: {
        title: "available_subagents",
        content:
          generation.subagentGuidance ??
          (generation.subagentRefresh.status === "disabled"
            ? "Subagent economics is disabled for this device."
            : `Subagent economics catalog is ${generation.subagentRefresh.status}.`),
      },
    })
    for (const agent of catalog?.agents ?? []) {
      options.push({
        category: "SystemPrompt",
        title: `  ${agent.agent}`,
        footer: `${agent.model.providerID}/${agent.model.modelID}`,
        value: { title: agent.agent, content: JSON.stringify(agent, null, 2) },
      })
    }
  }

  if (generation.compaction) {
    options.push({
      category: "Messages",
      title: "conversation-checkpoints",
      footer: `${generation.compaction.summary.length + generation.compaction.recent.length}chars`,
      value: {
        title: "conversation-checkpoints",
        content: renderConversationCheckpoint(generation.compaction),
      },
    })
  } else {
    options.push({
      category: "Messages",
      title: "conversation-checkpoints",
      value: {
        title: "conversation-checkpoints",
        content: "No compaction checkpoint has been produced for this Session.",
      },
    })
  }

  options.push({
    category: "Tools",
    title: "tool-definitions",
    value: { title: "tool-definitions", content: "Tool definitions are not yet exposed for inspection." },
  })

  return options.map((option) => (option.footer === undefined ? option : { ...option, footerWidth }))
}

export function showModelContext(
  dialog: DialogContext,
  generation: ModelContextGeneration | null,
  refreshInstructions?: () => Promise<ModelContextGeneration | null>,
) {
  if (!generation) return DialogAlert.show(dialog, "Model context", "No context generation has been established yet.")
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogModelContext generation={generation} refreshInstructions={refreshInstructions} />,
      resolve,
    )
  })
}

export function DialogModelContext(props: {
  generation: ModelContextGeneration
  refreshInstructions?: () => Promise<ModelContextGeneration | null>
}) {
  const dialog = useDialog()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const [generation, setGeneration] = createSignal(props.generation)
  const [refreshing, setRefreshing] = createSignal(false)
  const footerWidth = createMemo(() => Math.max(24, Math.floor(dimensions().width * 0.4)))

  const refresh = async () => {
    if (!props.refreshInstructions || refreshing()) return
    setRefreshing(true)
    try {
      const next = await props.refreshInstructions()
      if (!next) throw new Error("No context generation was returned")
      setGeneration(next)
      toast.show({
        title: "Instructions refreshed",
        message: `Current Session now uses generation ${next.generation}`,
        variant: "success",
      })
    } catch (error) {
      toast.show({
        title: "Instructions not refreshed",
        message: `${errorMessage(error)} Nothing changed.`,
        variant: "error",
      })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <DialogSelect
      title={`Model context · ${generation().generation} · ${generation().reason}`}
      locked={refreshing()}
      preserveSelection
      options={modelContextOptions(generation(), footerWidth())}
      footer={<text>{`location ${generation().locationRevision} · ${generation().digest.slice(0, 12)}`}</text>}
      footerHints={[{ title: "enter", label: "preview" }]}
      actions={
        props.refreshInstructions
          ? [
              {
                command: "dialog.model_context.refresh_instructions",
                title: refreshing() ? "refreshing instructions" : "refresh instructions",
                side: "right",
                disabled: refreshing(),
                onTrigger: () => void refresh(),
              },
            ]
          : undefined
      }
      onSelect={(option) =>
        dialog.push(() => <DialogModelContextPreview title={option.value.title} content={option.value.content} />)
      }
    />
  )
}

export function DialogModelContextPreview(props: Preview) {
  return (
    <DialogContentPreview
      {...props}
      commands={modelContextCommands}
      copySuccess="Context source copied to clipboard"
      copyFailure="Failed to copy context source"
    />
  )
}

export function DialogContentPreview(
  props: Preview & {
    commands: ContentPreviewCommands
    copySuccess: string
    copyFailure: string
  },
) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const { theme } = useTheme()
  const [copied, setCopied] = createSignal(false)
  const height = createMemo(() => Math.max(3, Math.floor((dimensions().height * 3) / 4) - 8))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const commandNames = () => [
    props.commands.lineUp,
    props.commands.lineDown,
    props.commands.pageUp,
    props.commands.pageDown,
    props.commands.home,
    props.commands.end,
    props.commands.copy,
  ]
  const bindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: commandNames() }),
  )
  const scrollLabel = createMemo(() =>
    formatKeyBindings(
      [props.commands.lineUp, props.commands.lineDown].flatMap((command) => bindings().get(command) ?? []),
      tuiConfig,
    ),
  )
  const copyLabel = createMemo(() => formatKeyBindings(bindings().get(props.commands.copy), tuiConfig))
  let scroll: ScrollBoxRenderable | undefined

  dialog.setSize("xlarge")

  function copy() {
    if (!clipboard.write) {
      toast.show({ message: "Clipboard is unavailable", variant: "error" })
      return
    }
    void clipboard.write(props.content).then(
      () => {
        setCopied(true)
        toast.show({ message: props.copySuccess, variant: "success" })
      },
      () => {
        setCopied(false)
        toast.show({ message: props.copyFailure, variant: "error" })
      },
    )
  }

  useBindings(() => ({
    commands: [
      {
        name: props.commands.lineUp,
        title: "Scroll up",
        category: "Dialog",
        run: () => scroll?.scrollBy(-1),
      },
      {
        name: props.commands.lineDown,
        title: "Scroll down",
        category: "Dialog",
        run: () => scroll?.scrollBy(1),
      },
      {
        name: props.commands.pageUp,
        title: "Page up",
        category: "Dialog",
        run: () => scroll?.scrollBy(-scroll.height),
      },
      {
        name: props.commands.pageDown,
        title: "Page down",
        category: "Dialog",
        run: () => scroll?.scrollBy(scroll.height),
      },
      {
        name: props.commands.home,
        title: "First line",
        category: "Dialog",
        run: () => scroll?.scrollTo(0),
      },
      {
        name: props.commands.end,
        title: "Last line",
        category: "Dialog",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
      {
        name: props.commands.copy,
        title: "Copy source",
        category: "Dialog",
        run: copy,
      },
    ],
    bindings: tuiConfig.keybinds.gather(props.commands.namespace, commandNames()),
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        maxHeight={height()}
        paddingRight={1}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <text fg={theme.text} wrapMode="word">
          {props.content}
        </text>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>{scrollLabel()} scroll</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>{copyLabel()}</span>
        </text>
      </box>
    </box>
  )
}

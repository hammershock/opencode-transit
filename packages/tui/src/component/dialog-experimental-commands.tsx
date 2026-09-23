import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onMount } from "solid-js"
import {
  experimentalCommandSettings,
  overrideDiagnostic,
  persistLocationEnvironment,
  persistBackgroundSubagents,
  persistSubagentEconomics,
  persistUserShellCwd,
} from "../command-toolkit/experimental-settings"
import { useCommandShortcut } from "../keymap"
import { useKV } from "../context/kv"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

function Status(props: { setting: (typeof experimentalCommandSettings)[number] }) {
  const kv = useKV()
  const { theme } = useTheme()
  const enabled = () => kv.get(props.setting.key, props.setting.defaultValue)
  const diagnostic = () => overrideDiagnostic(props.setting.id)

  return (
    <span
      style={{
        fg: diagnostic()?.status === "fallback" ? theme.warning : enabled() ? theme.success : theme.textMuted,
        attributes: enabled() ? TextAttributes.BOLD : undefined,
      }}
    >
      {diagnostic()?.status === "fallback" ? "! Enabled but not active" : enabled() ? "✓ Enabled" : "○ Disabled"}
    </span>
  )
}

export function DialogExperimentalCommands(props: { current?: string } = {}) {
  const kv = useKV()
  const sdk = useSDK()
  const toast = useToast()
  const saved = () => toast.show({ message: "Saved. Restart OpenCode to apply to existing sessions.", variant: "info" })
  const backgroundShortcut = useCommandShortcut("session.background")
  const [backgroundSaving, setBackgroundSaving] = createSignal(false)
  const [backgroundSubagents, setBackgroundSubagents] = createSignal<boolean | null>()
  const [locationEnvironment, setLocationEnvironment] = createSignal<boolean>()
  const [subagentEconomics, setSubagentEconomics] = createSignal<boolean>()
  const [userShellCwd, setUserShellCwd] = createSignal<boolean>()
  onMount(
    () =>
      void sdk.client.global.config
        .get({ throwOnError: true })
        .then((result) => {
          setBackgroundSubagents(result.data.experimental?.background_subagents ?? null)
          setLocationEnvironment(result.data.experimental?.location_env === true)
          setSubagentEconomics(result.data.experimental?.subagent_economics === true)
          setUserShellCwd(result.data.experimental?.user_shell_cwd === true)
        })
        .catch(toast.error),
  )
  const options = createMemo(() => [
    ...experimentalCommandSettings.map((setting) => ({
      value: setting.id,
      title: setting.title,
      description: setting.description,
      footer: () => <Status setting={setting} />,
      category: "Experimental commands",
    })),
    {
      value: "fork.subagent.background",
      title: "Background subagents",
      description: `User setting · run independent tasks asynchronously${backgroundShortcut() ? ` or detach with ${backgroundShortcut()}` : ""}. Restart to apply; project config can override.`,
      footer: backgroundSaving()
        ? "◐ saving"
        : backgroundSubagents() === undefined
          ? "◐ checking"
          : backgroundSubagents() === null
            ? "○ env default"
            : backgroundSubagents()
              ? "● saved on"
              : "○ saved off",
      category: "Experimental features",
      footerWidth: 15,
      descriptionAlign: "right" as const,
      descriptionWidth: 45,
    },
    {
      value: "fork.subagent.economics",
      title: "Subagent economics",
      description: "Device setting · give the parent Agent local pricing and routing evidence at Session activation",
      footer: subagentEconomics() === undefined ? "◐ checking" : subagentEconomics() ? "● saved on" : "○ saved off",
      category: "Experimental features",
    },
    {
      value: "fork.user-shell.cwd",
      title: "User Shell CWD continuity",
      description: "User setting · remember verified cwd until OpenCode exits",
      footer: userShellCwd() === undefined ? "◐ checking" : userShellCwd() ? "● saved on" : "○ saved off",
      category: "Experimental features",
      disabled: userShellCwd() === undefined,
    },
    {
      value: "fork.environment.location",
      title: "Location environment",
      description: "User setting · load target user and project .env files for Shell and Agent tools",
      footer: locationEnvironment() === undefined ? "◐ checking" : locationEnvironment() ? "● saved on" : "○ saved off",
      category: "Experimental features",
      disabled: locationEnvironment() === undefined,
    },
  ])

  return (
    <DialogSelect
      title="Experimental commands"
      options={options()}
      current={props.current}
      actions={[
        {
          command: "dialog.experimental.toggle",
          title: "toggle",
          disabled: (option) =>
            option?.value === "fork.subagent.background" && (backgroundSubagents() === undefined || backgroundSaving()),
          onTrigger: (option: DialogSelectOption<string>) => {
            if (option.value === "fork.subagent.background") {
              const current = backgroundSubagents()
              if (current === undefined || backgroundSaving()) return
              setBackgroundSaving(true)
              void persistBackgroundSubagents(!current, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setBackgroundSubagents)
                .then(saved)
                .catch(toast.error)
                .finally(() => setBackgroundSaving(false))
              return
            }
            if (option.value === "fork.subagent.economics") {
              const current = subagentEconomics()
              if (current === undefined) return
              const enabled = !current
              void persistSubagentEconomics(enabled, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setSubagentEconomics)
                .then(saved)
                .catch(toast.error)
              return
            }
            if (option.value === "fork.user-shell.cwd") {
              const current = userShellCwd()
              if (current === undefined) return
              const enabled = !current
              void persistUserShellCwd(enabled, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setUserShellCwd)
                .then(saved)
                .catch(toast.error)
              return
            }
            if (option.value === "fork.environment.location") {
              const current = locationEnvironment()
              if (current === undefined) return
              const enabled = !current
              void persistLocationEnvironment(enabled, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setLocationEnvironment)
                .then(saved)
                .catch(toast.error)
              return
            }
            const setting = experimentalCommandSettings.find((item) => item.id === option.value)
            if (!setting) return
            kv.set(setting.key, !kv.get(setting.key, setting.defaultValue))
          },
        },
      ]}
      onSelect={() => {}}
    />
  )
}

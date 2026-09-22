import { batch, createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useTuiPaths } from "../../context/runtime"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, displayTruncate, inspectionFrame } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { loadDialogSessionList } from "../../component/dialog-session-list"
import { abbreviateHome } from "../../runtime"
import { errorMessage } from "../../util/error"
import { useHomeSessionDestination } from "./session-destination"
import { recentLocations, type RecentLocation } from "./recent-locations"
import { validateDestination } from "./target-workflow"

export function useRecentLocations(targets: () => { targets: readonly { id: string; name: string }[] } | undefined) {
  const sdk = useSDK()
  const paths = useTuiPaths()
  const destination = useHomeSessionDestination()!
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [sessions, { refetch }] = createResource(() =>
    loadDialogSessionList({ list: (query, options) => sdk.client.experimental.session.list(query, options) }),
  )
  const rows = createMemo(() =>
    recentLocations(sessions() ?? []).map((row) => {
      const target = row.target
      if (target.type === "local") return row
      const configured = targets()?.targets.find((item) => item.id === target.targetID)
      return { ...row, target: { ...target, name: configured?.name ?? target.name } }
    }),
  )
  const [pending, setPending] = createSignal<string>()
  const selected = createMemo(() => {
    const target = destination.target()
    const directory = destination.destination()
    if (directory?.type !== "directory") return
    return rows().find(
      (row) =>
        row.directory === directory.directory &&
        (row.target.type === "local"
          ? target.type === "local"
          : target.type === "rexd" && row.target.targetID === target.targetID),
    )?.key
  })
  let generation = 0
  onCleanup(() => generation++)

  async function choose(row: RecentLocation, current: () => boolean = () => true) {
    const attempt = ++generation
    const previousTarget = destination.target()
    const previousDirectory = destination.destination()
    const previousDialog = dialog.stack.at(-1)
    const active = () =>
      attempt === generation &&
      current() &&
      dialog.stack.at(-1) === previousDialog &&
      destination.target() === previousTarget &&
      destination.destination() === previousDirectory
    setPending(row.key)
    try {
      const target = await (async () => {
        const selected = row.target
        if (selected.type === "local") return selected
        const registry = await sdk.client.v2.target.list({ throwOnError: true })
        const found = registry.data.targets.find((target) => target.id === selected.targetID)
        if (!found) throw new Error("Target is no longer configured. Restore it in /target or choose another location.")
        return { type: "rexd" as const, targetID: found.id, name: found.name }
      })()
      if (!active()) return
      await validateDestination({
        target,
        directory: row.directory,
        prepare: async (targetID) => (await sdk.client.v2.target.prepare({ targetID }, { throwOnError: true })).data,
        validate: async (candidate) => {
          await sdk.client.v2.fs.list(
            {
              location: {
                directory: candidate.directory,
                ...(candidate.target.type === "rexd" ? { target: candidate.target.targetID } : {}),
              },
              path: ".",
            },
            { throwOnError: true },
          )
        },
      })
      if (!active()) return
      batch(() => {
        destination.setTarget(target)
        destination.setDestination({ type: "directory", directory: row.directory, subdirectory: false })
      })
      dialog.clear()
    } catch (error) {
      if (active())
        toast.show({ title: "Cannot select recent location", message: errorMessage(error), variant: "error" })
    } finally {
      if (attempt === generation) setPending(undefined)
    }
  }

  function open() {
    generation++
    setPending(undefined)
    if (!sessions.loading) void refetch()
    const view = () => (
      <DialogSelect
        title="Recent locations"
        placeholder="Search target or directory"
        current={selected()}
        locked={pending() !== undefined}
        options={rows().map((row) => ({
          title: `${row.target.type === "local" ? "local" : row.target.name} · ${row.directory}`,
          inspectionTitle: `${row.target.type === "local" ? "local" : row.target.name} · ${row.target.type === "local" ? abbreviateHome(row.directory, paths.home) : row.directory}`,
          value: row.key,
          truncateTitle: true,
          inspectTitle: true,
          footer: pending() === row.key ? "◐ checking" : selected() === row.key ? "● selected" : undefined,
          footerWidth: 10,
        }))}
        emptyView={
          <text fg={theme.textMuted}>
            {sessions.loading
              ? "Loading recent locations…"
              : sessions() === undefined
                ? "Could not load locations. Reopen /recent to retry."
                : "No recent locations yet. Start a session to add one."}
          </text>
        }
        onSelect={(option) => {
          const row = rows().find((row) => row.key === option.value)
          if (row) void choose(row, () => dialog.isCurrent(view))
        }}
      />
    )
    dialog.replace(view, () => {
      generation++
      setPending(undefined)
    })
  }

  return {
    rows,
    pending,
    selected,
    loading: () => sessions.loading,
    failed: () => !sessions.loading && sessions() === undefined,
    choose,
    open,
  }
}

export function RecentLocations(props: { recent: ReturnType<typeof useRecentLocations>; width: number }) {
  const { theme } = useTheme()
  const paths = useTuiPaths()
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal<string>()
  const [offset, setOffset] = createSignal(0)
  createEffect(() => {
    const focused = hovered()
    setOffset(0)
    if (!focused) return
    const timer = setInterval(() => setOffset((value) => value + 1), 300)
    onCleanup(() => clearInterval(timer))
  })
  const count = () => (dimensions().height < 26 ? 1 : dimensions().height < 30 ? 2 : 3)
  const width = () => Math.max(1, Math.min(props.width, dimensions().width - 4))
  const targetWidth = () => Math.min(16, Math.max(5, Math.floor(width() / 4)))
  const directoryWidth = () => Math.max(0, width() - targetWidth() - 14)
  const label = (value: string, budget: number, key: string) =>
    hovered() === key ? inspectionFrame(value, budget, offset()) : displayTruncate(value, budget)
  return (
    <box width="100%" maxWidth={props.width} marginTop={1} flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" onMouseUp={props.recent.open}>
        <text fg={theme.textMuted}>Recent locations</text>
        <text fg={theme.textMuted}>/recent</text>
      </box>
      <Show
        when={props.recent.rows().length}
        fallback={
          <text fg={theme.textMuted} truncate>
            {props.recent.loading()
              ? "Loading…"
              : props.recent.failed()
                ? "Unavailable · /recent to retry"
                : "Start a session to add a location"}
          </text>
        }
      >
        <For each={props.recent.rows().slice(0, count())}>
          {(row) => (
            <box
              flexDirection="row"
              width={width()}
              height={1}
              backgroundColor={hovered() === row.key ? theme.backgroundElement : undefined}
              onMouseOver={() => setHovered(row.key)}
              onMouseOut={() => setHovered(undefined)}
              onMouseUp={() => void props.recent.choose(row)}
            >
              <text width={targetWidth()} fg={theme.textMuted} truncate>
                {label(row.target.type === "local" ? "local" : row.target.name, targetWidth(), row.key)}
              </text>
              <text fg={theme.textMuted} flexShrink={0}>
                {" "}
                ·{" "}
              </text>
              <text fg={hovered() === row.key ? theme.text : theme.textMuted} width={directoryWidth()} truncate>
                {label(
                  row.target.type === "local" ? abbreviateHome(row.directory, paths.home) : row.directory,
                  directoryWidth(),
                  row.key,
                )}
              </text>
              <text width={11} fg={theme.textMuted}>
                {props.recent.pending() === row.key
                  ? " ◐ checking"
                  : props.recent.selected() === row.key
                    ? " ● selected"
                    : ""}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

import { createResource, createSignal, Match, Switch, untrack } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt, type DialogPromptProps } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { errorMessage } from "../util/error"
import {
  completeWorkspaceRoots,
  targetDescription,
  targetWizard,
  type TargetDefinition,
  type TargetInput,
} from "./target-wizard"
import { targetInput, targetWizardServices } from "./location-directory-workflow"
import { useTheme } from "../context/theme"

export type TargetHealthState = "checking" | "ready" | "unavailable" | "invalid"

type TargetHealthResult = {
  readonly status: Exclude<TargetHealthState, "checking">
  readonly stage?: string
  readonly message?: string
  readonly checkedAt?: number
  readonly trustedUntil?: number
}

export async function probeTargetHealth(
  targetIDs: readonly string[],
  probe: (targetID: string) => Promise<TargetHealthResult | undefined>,
  publish: (targetID: string, result: TargetHealthResult | undefined) => void,
) {
  await Promise.all(
    targetIDs.map(async (targetID) => {
      const result = await Promise.resolve()
        .then(() => probe(targetID))
        .catch(() => undefined)
      publish(targetID, result)
    }),
  )
}

export function targetProbeGenerations() {
  let next = 0
  const current = new Map<string, number>()
  return {
    begin(targetIDs: readonly string[]) {
      const generation = ++next
      for (const targetID of targetIDs) current.set(targetID, generation)
      return generation
    },
    accept(targetID: string, generation: number) {
      if (current.get(targetID) !== generation) return false
      current.delete(targetID)
      return true
    },
  }
}

export function targetHealthLabel(state: TargetHealthState) {
  return {
    checking: "◐ checking",
    ready: "● ready",
    unavailable: "! unavailable",
    invalid: "! invalid",
  }[state]
}

export function targetListPresentation(
  target: { readonly description?: string; readonly connection: { readonly host: string } },
) {
  return {
    description: target.description ?? target.connection.host,
  }
}

export type TargetField = "name" | "description" | "roots" | "directory"

export function targetInfoFields(target: TargetDefinition): DialogSelectOption<TargetField>[] {
  return [
    {
      title: "Target name",
      value: "name",
      description: target.name,
      descriptionAlign: "right",
      descriptionWidth: 40,
    },
    {
      title: "Description",
      value: "description",
      description: target.description ?? "—",
      descriptionAlign: "right",
      descriptionWidth: 40,
    },
    {
      title: "Workspace root",
      value: "roots",
      description: target.workspaceRoots.join(", "),
      descriptionAlign: "right",
      descriptionWidth: 40,
    },
    {
      title: "Default working directory",
      value: "directory",
      description: target.defaultDirectory ?? "—",
      descriptionAlign: "right",
      descriptionWidth: 40,
    },
  ]
}

export function TargetHealth(props: { state: () => TargetHealthState }) {
  const { theme } = useTheme()
  return (
    <Switch>
      <Match when={props.state() === "checking"}>
        <span style={{ fg: theme.warning }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "ready"}>
        <span style={{ fg: theme.success }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "unavailable"}>
        <span style={{ fg: theme.error }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "invalid"}>
        <span style={{ fg: theme.error }}>{targetHealthLabel(props.state())}</span>
      </Match>
    </Switch>
  )
}

function RemoveTargetConfirm(props: { target: TargetDefinition; onRemove: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  useBindings(() => ({
    priority: 1,
    bindings: [
      {
        key: "return",
        desc: "Remove target",
        group: "Dialog",
        cmd: () => {
          dialog.pop()
          props.onRemove()
        },
      },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Remove target
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Remove {props.target.name} from this device? Referencing Sessions are preserved as unresolved.
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.error}
          onMouseUp={() => {
            dialog.pop()
            props.onRemove()
          }}
        >
          <text fg={theme.selectedListItemText}>Remove</text>
        </box>
        <box paddingLeft={1} paddingRight={1} onMouseUp={() => dialog.pop()}>
          <text fg={theme.textMuted}>Cancel</text>
        </box>
      </box>
    </box>
  )
}

export function useTargetManager() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [targets, controls] = createResource(async () => {
    const result = await sdk.client.v2.target.list({ throwOnError: true })
    return result.data
  })
  const [health, setHealth] = createSignal<Record<string, TargetHealthResult | undefined>>({})
  const [checking, setChecking] = createSignal<ReadonlySet<string>>(new Set())
  const [current, setCurrent] = createSignal<TargetDefinition>()
  const probeGeneration = targetProbeGenerations()

  const refreshHealth = async (force = false) => {
    const definitions = targets()?.targets ?? []
    const now = Date.now()
    const cached = new Map(
      definitions.flatMap((target) => {
        const value = target.health
        if (!value || typeof value.trustedUntil !== "number" || value.trustedUntil <= now) return []
        return [[target.id, value as TargetHealthResult] as const]
      }),
    )
    if (!force && cached.size) {
      setHealth((current) => ({ ...current, ...Object.fromEntries(cached) }))
      setChecking((current) => {
        const next = new Set(current)
        for (const targetID of cached.keys()) next.delete(targetID)
        return next
      })
    }
    const currentHealth = untrack(health)
    const ids = definitions
      .filter((target) => {
        if (force) return true
        const value = cached.get(target.id) ?? currentHealth[target.id]
        return !value?.trustedUntil || value.trustedUntil <= now
      })
      .map((target) => target.id)
    if (!ids.length) return
    const generation = probeGeneration.begin(ids)
    setChecking((current) => new Set([...current, ...ids]))
    await probeTargetHealth(
      ids,
      (targetID) =>
        (force
          ? sdk.client.v2.target.refresh({ targetID }, { throwOnError: true })
          : sdk.client.v2.target.test({ targetID }, { throwOnError: true })
        ).then((result) => result.data as TargetHealthResult),
      (targetID, result) => {
        if (!probeGeneration.accept(targetID, generation)) return
        setHealth((current) => ({ ...current, [targetID]: result }))
        setChecking((current) => {
          const next = new Set(current)
          next.delete(targetID)
          return next
        })
      },
    )
  }

  const state = (targetID: string): TargetHealthState => {
    if (checking().has(targetID)) return "checking"
    const result = health()?.[targetID]
    if (!result) return "unavailable"
    return result.status
  }

  const detail = (targetID: string) => {
    if (checking().has(targetID)) return undefined
    const result = health()?.[targetID]
    return result && result.status !== "ready" ? `${result.stage}: ${result.message}` : undefined
  }

  const wizard = targetWizardServices(sdk)

  const update = async (target: TargetDefinition, input: TargetInput) => {
    const snapshot = targets()
    if (!snapshot) return undefined
    await sdk.client.v2.target.update(
      { targetID: target.id, input, expectedRevision: snapshot.revision },
      { throwOnError: true },
    )
    await controls.refetch()
    return targets()?.targets.find((item) => item.id === target.id) as TargetDefinition | undefined
  }

  const prompt = (
    title: string,
    options: Omit<DialogPromptProps, "title" | "onConfirm" | "onCancel">,
  ): Promise<string | null> => {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      dialog.push(
        () => (
          <DialogPrompt
            title={title}
            {...options}
            onConfirm={(value) => {
              finish(value)
              dialog.pop()
            }}
          />
        ),
        () => {
          dialog.setSize("large")
          finish(null)
        },
      )
    })
  }

  const remove = (target: TargetDefinition) => {
    dialog.push(
      () => (
        <RemoveTargetConfirm
          target={target}
          onRemove={() => {
            void (async () => {
              const snapshot = targets()
              if (!snapshot) return
              await sdk.client.v2.target.remove(
                { targetID: target.id, expectedRevision: snapshot.revision },
                { throwOnError: true },
              )
              await controls.refetch()
              open()
            })().catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
          }}
        />
      ),
      () => dialog.setSize("large"),
    )
    dialog.setSize("medium")
  }

  const save = () => {
    void (async () => {
      const snapshot = targets()
      if (!snapshot) return
      const input = await targetWizard(dialog, undefined, wizard)
      if (!input) return
      try {
        const result = await sdk.client.v2.target.create(
          { input, expectedRevision: snapshot.revision },
          { throwOnError: true },
        )
        await controls.refetch()
        const tested = await sdk.client.v2.target.test({ targetID: result.data.target.id }, { throwOnError: true })
        toast.show({
          title: result.data.target.name,
          message:
            tested.data.status === "ready"
              ? "Target verified"
              : `Saved unverified · ${tested.data.stage}: ${tested.data.message}`,
          variant: tested.data.status === "ready" ? "success" : "warning",
        })
        open()
      } catch (error) {
        toast.show({ title: "Target save failed", message: errorMessage(error), variant: "error" })
      }
    })()
  }

  const inspect = (target: TargetDefinition) => {
    setCurrent(target)
    dialog.push(() => (
      <DialogSelect<TargetField>
        title={current()!.name}
        options={targetInfoFields(current()!)}
        actions={[{ command: "dialog.target.delete", title: "delete", onTrigger: () => remove(current()!) }]}
        onSelect={(option) => editField(option.value)}
      />
    ))
    dialog.setSize("large")
  }

  const editField = (field: TargetField) => {
    const target = current()
    if (!target) return
    void (async () => {
      if (field === "name") {
        const name = await prompt("Target name", { value: target.name, placeholder: "gpu-server" })
        if (name === null || !name.trim()) return
        const updated = await update(target, targetInput({ ...target, name: name.trim() }))
        if (updated) setCurrent(updated)
        return
      }
      if (field === "description") {
        const description = await prompt("Description", {
          value: target.description,
          placeholder: "Huawei ModelArts 2×A100 GPU server",
        })
        if (description === null) return
        const updated = await update(
          target,
          targetInput({ ...target, description: targetDescription(description).description }),
        )
        if (updated) setCurrent(updated)
        return
      }
      if (field === "roots") {
        const input = targetInput(target)
        const home = (await wizard.inspect(input))?.home ?? "/"
        const roots = await prompt("Workspace root", {
          value: target.workspaceRoots.join(", "),
          placeholder: "/",
          complete: (value, cursor) => completeWorkspaceRoots(wizard.complete, input, value, cursor, home),
        })
        if (roots === null) return
        const workspaceRoots = roots
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
        if (!workspaceRoots.length) return
        const updated = await update(target, targetInput({ ...target, workspaceRoots }))
        if (updated) setCurrent(updated)
        return
      }
      const input = targetInput(target)
      const home = (await wizard.inspect(input))?.home ?? target.defaultDirectory ?? "/"
      const directory = await prompt("Default working directory", {
        value: target.defaultDirectory ?? "",
        placeholder: home,
        complete: (value, cursor) => wizard.complete(input, value, cursor, home),
      })
      if (directory === null) return
      const updated = await update(target, targetInput({ ...target, defaultDirectory: directory.trim() || undefined }))
      if (updated) setCurrent(updated)
    })().catch((error) => toast.show({ title: "Target update failed", message: errorMessage(error), variant: "error" }))
  }

  function open(mode: "manage" | "add" = "manage") {
    if (mode === "add") return save()
    void refreshHealth()
    dialog.replace(() => (
      <DialogSelect<TargetDefinition>
        title="Manage targets"
        locked={targets.loading}
        options={(targets()?.targets ?? []).map((target) => ({
          title: target.name,
          ...targetListPresentation(target),
          descriptionAlign: "right" as const,
          descriptionWidth: 40,
          footer: () => <TargetHealth state={() => state(target.id)} />,
          value: target as TargetDefinition,
          category: "Configured targets",
        }))}
        actions={[
          { command: "dialog.target.add", title: "add", onTrigger: () => save() },
          { command: "dialog.target.refresh", title: "refresh", onTrigger: () => void refreshHealth(true) },
          { command: "dialog.target.delete", title: "delete", onTrigger: (option) => remove(option.value) },
        ]}
        onSelect={(option) => inspect(option.value)}
      />
    ))
    dialog.setSize("large")
  }

  return {
    targets,
    health,
    state,
    detail,
    refreshHealth,
    refetch: async () => {
      await controls.refetch()
      await refreshHealth()
    },
    open,
  }
}

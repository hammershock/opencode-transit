import { createSignal, onCleanup, onMount } from "solid-js"
import type { SessionPolicyView } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

export function policyChoices(view: SessionPolicyView) {
  return view.baseline
    .filter((rule) => rule.effect === "allow")
    .map((_, index) => view.status === "reviewed" && view.review?.accepted[index] === true)
}

function message(error: unknown) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message.replace(/[\r\n\t]/g, " ")
    : "Permission policy request failed. Reload and retry."
}

export function DialogSessionPolicy(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [view, setView] = createSignal<SessionPolicyView>()
  const [accepted, setAccepted] = createSignal<boolean[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const request = { id: crypto.randomUUID(), generation: 0, alive: true }
  const abort = new AbortController()
  onCleanup(() => {
    request.alive = false
    abort.abort()
  })

  async function reload() {
    const generation = ++request.generation
    setBusy(true)
    setError(undefined)
    try {
      const result = await sdk.client.v2.session.policy.inspect(
        { sessionID: props.sessionID },
        { throwOnError: true, signal: abort.signal },
      )
      if (!request.alive || generation !== request.generation) return
      setView(result.data.data)
      setAccepted(policyChoices(result.data.data))
      request.id = crypto.randomUUID()
    } catch (cause) {
      if (request.alive && generation === request.generation) setError(message(cause))
    } finally {
      if (request.alive && generation === request.generation) setBusy(false)
    }
  }

  async function apply() {
    const current = view()
    if (!current || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await sdk.client.v2.session.policy.review(
        {
          sessionID: props.sessionID,
          sessionPolicyRequest: {
            requestID: request.id,
            expectedRevision: current.revision,
            legacyDigest: current.legacyDigest,
            locationRevision: current.locationRevision,
            location: current.location,
            accepted: accepted(),
          },
        },
        { throwOnError: true, signal: abort.signal },
      )
      if (!request.alive) return
      toast.show({ message: "Session policy review saved", variant: "success" })
      await reload()
    } catch (cause) {
      if (request.alive) setError(`${message(cause)} Reload if the policy or Location changed.`)
    } finally {
      if (request.alive) setBusy(false)
    }
  }

  const options = (): DialogSelectOption<string>[] => {
    const current = view()
    return [
      {
        title: "Policy status",
        value: "status",
        description: busy() ? "checking" : (current?.status ?? "unavailable"),
        descriptionAlign: "right",
        descriptionWidth: 12,
        footer: current
          ? `${current.location.target?.type ?? "local"} · ${current.location.directory}`
          : "Loading Session policy",
        inspectFooter: true,
      },
      ...(current?.baseline.filter((rule) => rule.effect === "allow") ?? []).map((rule, index) => ({
        title: `${rule.action}: ${rule.resource}`.replace(/[\r\n\t]/g, " "),
        value: `allow:${index}`,
        description: accepted()[index] ? "● retain" : "○ drop",
        descriptionAlign: "right" as const,
        descriptionWidth: 10,
        titleWidth: 24,
        truncateTitle: true,
        inspectTitle: true,
        footer: "Toggle whether to retain this historical allow. Agent and parent restrictions still apply.",
        disabled: busy(),
      })),
      {
        title: "Apply reviewed policy",
        value: "apply",
        disabled: busy() || !view() || accepted().length === 0,
        footer: error() ?? "Only this Session and its current Location. Original history is preserved.",
        inspectFooter: true,
      },
      { title: "Reload policy", value: "reload", disabled: busy(), footer: error(), inspectFooter: true },
      { title: "Close", value: "close", footer: "Unsubmitted choices are discarded." },
    ]
  }
  onMount(() => void reload())
  return (
    <DialogSelect
      title="Session permissions"
      options={options()}
      preserveSelection
      skipFilter
      renderFilter={false}
      onSelect={(option) => {
        if (option.value === "close") return dialog.clear()
        if (busy()) return
        if (option.value === "reload") return void reload()
        if (option.value === "apply") return void apply()
        if (!option.value.startsWith("allow:")) return
        const index = Number(option.value.slice(6))
        setAccepted((values) => values.map((value, position) => (position === index ? !value : value)))
        request.id = crypto.randomUUID()
      }}
    />
  )
}

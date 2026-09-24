import type { V2SessionTaskStatusResponses } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { useKV } from "../../context/kv"
import { stopOperationKey, submitTaskStop } from "../../util/task-stop-retry"
import { promptBackend } from "../../util/prompt-backend"

type View = V2SessionTaskStatusResponses[200]["data"][number]
type Page = V2SessionTaskStatusResponses[200]

export function taskStatusLabel(view: View) {
  const state = view.outcome ?? (view.eligibility === "frozen" ? "frozen" : view.lifecycle)
  return [state, view.phase === "unknown" ? undefined : view.phase, view.runtime].filter(Boolean).join(" · ")
}

export function taskDetails(view: View) {
  const location = [view.location.target_name ?? view.location.target_id ?? "Local", view.location.directory]
    .filter(Boolean)
    .join(" · ")
  const tools = view.active_tools.slice(0, 4).map((item) => item.name).join(", ")
  return [
    `Location ${location}`,
    `Runtime ${view.runtime} · read ${new Date(view.read_at).toLocaleTimeString()}`,
    ...(view.runtime_observation
      ? [`Owner observed ${new Date(view.runtime_observation.observed_at).toLocaleTimeString()}`]
      : []),
    ...(view.last_progress_at ? [`Last progress ${new Date(view.last_progress_at).toLocaleTimeString()}`] : []),
    `Active tools ${view.active_tool_count}${tools ? ` · ${tools}${view.active_tool_count > 4 ? ", …" : ""}` : ""}`,
    ...(view.root_quota
      ? [`Root capacity ${view.root_quota.active_used}/${view.root_quota.active_limit} active, ${view.root_quota.pending_used}/${view.root_quota.pending_limit} pending`]
      : []),
    ...(view.disposition === "abandoned_unknown" ? ["Archived unknown; no terminal result was inferred"] : []),
  ]
}

export function DialogTaskList(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const route = useRoute()
  const toast = useToast()
  const kv = useKV()
  const [rows, setRows] = createSignal<View[]>([])
  const [next, setNext] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const pending = new Map<string, string>()
  let generation = 0

  const receipt = async <T,>(action: string, call: () => Promise<{ data: T }>) => {
    setBusy(true)
    try {
      const result = (await call()).data
      toast.show({ title: action, message: JSON.stringify(result).slice(0, 512), variant: "success" })
      await load()
      return result
    } catch (error) {
      toast.show({ title: `${action} unavailable`, message: errorMessage(error), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const load = async (cursor?: string) => {
    const token = ++generation
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await sdk.client.v2.session.task.status(
        { sessionID: props.sessionID, limit: 32, cursor, include_results: true },
        { throwOnError: true },
      )
      const page: Page = response.data
      if (token !== generation) return
      setRows(cursor ? [...rows(), ...page.data] : page.data)
      setNext(page.next)
    } catch (error) {
      if (token !== generation) return
      setFailure(errorMessage(error))
    } finally {
      if (token === generation) setBusy(false)
    }
  }

  const showChild = (child: View) => {
    const [history, setHistory] = createSignal<View[]>([])
    const [cursor, setCursor] = createSignal<string>()
    const [error, setError] = createSignal<string>()
    const refresh = async (after?: string) => {
      try {
        const response = await sdk.client.v2.session.task.status(
          {
            sessionID: props.sessionID,
            target: { task_id: child.target.task_id },
            limit: 32,
            cursor: after,
            include_results: true,
          },
          { throwOnError: true },
        )
        setHistory(after ? [...history(), ...response.data.data] : response.data.data)
        setCursor(response.data.next)
        setError(undefined)
      } catch (failure) {
        setError(errorMessage(failure))
      }
    }
    const stop = async (retry: boolean) => {
      try {
        await submitTaskStop({
          store: kv,
          parentSessionID: props.sessionID,
          childSessionID: child.target.task_id,
          retry,
          send: async (operation) => {
            const result = await sdk.client.v2.session.task.stop(
              { sessionID: props.sessionID, task_id: child.target.task_id, operation_id: operation },
              { throwOnError: true },
            )
            toast.show({ title: "Task stop receipt", message: JSON.stringify(result.data).slice(0, 512), variant: "success" })
            return result.data
          },
        })
      } catch (error) {
        toast.show({ title: "Task stop unavailable", message: errorMessage(error), variant: "error" })
      }
      await load()
      await refresh()
    }
    dialog.push(() => {
      onMount(() => void refresh())
      return (
        <DialogSelect<View | "more" | "refresh" | "stop" | "retry-stop" | "error">
          title={`Task · ${child.description}`}
          locked={busy() || !kv.ready}
          options={[
            ...history().map((view) => ({
              title: `${taskStatusLabel(view)} · ${view.input_id ?? "legacy"}`,
              value: view,
              description: view.result?.summary ?? `${view.active_tool_count} active tools · ${view.queued_count} queued`,
              details: taskDetails(view),
            })),
            ...(cursor() ? [{ title: "Load older invocations", value: "more" as const }] : []),
            { title: "Refresh", value: "refresh" as const },
            ...(kv.get(stopOperationKey(props.sessionID, child.target.task_id))
              ? [{ title: "Retry original stop scope", value: "retry-stop" as const }]
              : [{ title: "Stop current and pending snapshot", value: "stop" as const }]),
            ...(error() ? [{ title: `Unavailable: ${error()}`, value: "error" as const, disabled: true }] : []),
          ]}
          onSelect={(option) => {
            if (option.value === "more") return void refresh(cursor())
            if (option.value === "refresh") return void refresh()
            if (option.value === "stop") return void stop(false)
            if (option.value === "retry-stop") return void stop(true)
            if (option.value === "error") return
            showInvocation(option.value)
          }}
        />
      )
    })
  }

  const showInvocation = (view: View) => {
    const target = view.target.invocation && view.input_id
      ? { task_id: view.target.task_id, invocation: view.target.invocation, input_id: view.input_id }
      : undefined
    const operation = (action: string, text = "") => {
      const key = `${action}:${view.input_id}:${text}`
      const value = pending.get(key) ?? crypto.randomUUID()
      pending.set(key, value)
      return { key, value }
    }
    const send = () => {
      if (!target) return
      dialog.push(() => (
        <DialogPrompt
          title="Send direct child input"
          description={() => "A durable receipt confirms admission; promotion and model reading happen later."}
          onConfirm={(text) => {
            if (!text.trim()) return
            const id = operation("send", text)
            void receipt("Task send receipt", () =>
              sdk.client.v2.session.task.send(
                { sessionID: props.sessionID, target, operation_id: id.value, text },
                { throwOnError: true },
              ),
            ).then((result) => {
              if (result) pending.delete(id.key)
              dialog.pop()
            })
          }}
        />
      ))
    }
    const reconcile = async (disposition: "resume_pending" | "cancel_pending") => {
      if (!target) return
      const id = operation(disposition)
      const result = await receipt("Task reconcile receipt", () =>
        sdk.client.v2.session.task.reconcile(
          { sessionID: props.sessionID, target, operation_id: id.value, disposition },
          { throwOnError: true },
        ),
      )
      if (result) pending.delete(id.key)
    }
    const archive = async () => {
      if (!target || !sdk.archiveUnknown) return
      const id = operation("archive")
      const result = await receipt("Unknown Task archived", () =>
        sdk.archiveUnknown!({
          parentSessionID: props.sessionID,
          childSessionID: view.target.task_id,
          inputID: target.input_id,
          operationID: id.value,
        }).then((data) => ({ data })),
      )
      if (result) pending.delete(id.key)
    }
    const parentRequest = async (mode: "progress" | "continue", text = "") => {
      const taskID = JSON.stringify(view.target.task_id)
      const prompt = mode === "progress"
        ? `Use Task with task_id=${taskID} to ask the child what progress it saved after the interrupted invocation. Ask for a summary only; do not claim to resume its interrupted tool.`
        : `Use Task with task_id=${taskID} to start a new follow-up invocation for this request: ${text}`
      try {
        const backend = await promptBackend(props.sessionID, sdk.request)
        if (backend === "v2")
          await sdk.client.v2.session.prompt({ sessionID: props.sessionID, prompt: { text: prompt } }, { throwOnError: true })
        else
          await sdk.client.session.promptAsync(
            { sessionID: props.sessionID, parts: [{ type: "text", text: prompt }] },
            { throwOnError: true },
          )
        toast.show({
          title: "Parent request submitted",
          message: "The child receives a new input only if the parent calls Task and gets an admission receipt.",
          variant: "success",
        })
        return true
      } catch (error) {
        toast.show({ title: "Parent request unavailable", message: errorMessage(error), variant: "error" })
        return false
      }
    }
    const continueTask = () =>
      dialog.push(() => (
        <DialogPrompt
          title="Continue child with a new Task"
          description={() => "This submits a parent prompt; it does not resume an interrupted tool."}
          onConfirm={(text) => {
            if (!text.trim()) return
            void parentRequest("continue", text).then((sent) => {
              if (sent) dialog.pop()
            })
          }}
        />
      ))
    dialog.push(() => (
      <DialogSelect<"open" | "send" | "wait" | "interrupt" | "resume" | "cancel" | "archive" | "progress" | "continue">
        title={`${taskStatusLabel(view)} · ${view.description}`}
        locked={busy()}
        options={[
          {
            title: "Open child history",
            value: "open" as const,
            description: view.target.task_id,
          },
          { title: "Ask child for saved progress", value: "progress" as const },
          { title: "Request a new follow-up Task", value: "continue" as const },
          ...(target
            ? [
                { title: "Steer active invocation", value: "send" as const, disabled: view.lifecycle !== "active" || view.runtime !== "observed" },
                { title: "Wait for this invocation", value: "wait" as const },
                { title: "Interrupt this invocation", value: "interrupt" as const },
                ...(view.eligibility === "frozen"
                  ? [
                      { title: "Resume frozen input", value: "resume" as const },
                      { title: "Cancel frozen input", value: "cancel" as const },
                    ]
                  : []),
                ...(view.runtime === "unknown" && sdk.archiveUnknown
                  ? [{ title: "Archive unknown after owner exit", value: "archive" as const }]
                  : []),
              ]
            : []),
        ]}
        onSelect={(option) => {
          if (option.value === "open") {
            route.navigate({ type: "session", sessionID: view.target.task_id })
            dialog.clear()
          }
          if (option.value === "send") send()
          if (option.value === "progress") void parentRequest("progress")
          if (option.value === "continue") continueTask()
          if (option.value === "resume") void reconcile("resume_pending")
          if (option.value === "cancel") void reconcile("cancel_pending")
          if (option.value === "archive") void archive()
          if (option.value === "interrupt" && target)
            void receipt("Task interrupt receipt", () =>
              sdk.client.v2.session.task.interrupt({ sessionID: props.sessionID, target }, { throwOnError: true }),
            )
          if (option.value === "wait" && target)
            void receipt("Task wait receipt", () =>
              sdk.client.v2.session.task.wait(
                { sessionID: props.sessionID, targets: [target], until: "change", timeout_ms: 30_000 },
                { throwOnError: true },
              ),
            )
        }}
      />
    ))
  }

  onMount(() => {
    const off = sdk.event.on("event", (event) => {
      if (
        event.payload.type.startsWith("session.task.") ||
        event.payload.type === "session.next.delegation.result.recorded"
      )
        void load()
    })
    onCleanup(off)
    void load()
  })
  return (
    <DialogSelect<View | "more" | "refresh" | "error">
      title="Background Tasks"
      locked={busy()}
      options={[
        ...rows().map((view) => ({
          title: `${taskStatusLabel(view)} · ${view.description}`,
          value: view,
          description: `${view.agent_id} · ${view.queued_count} queued`,
        })),
        ...(next() ? [{ title: "Load more Tasks", value: "more" as const }] : []),
        { title: "Refresh", value: "refresh" as const },
        ...(failure() ? [{ title: `Unavailable: ${failure()}`, value: "error" as const, disabled: true }] : []),
      ]}
      onSelect={(option) => {
        if (option.value === "more") return void load(next())
        if (option.value === "refresh") return void load()
        if (option.value === "error") return
        showChild(option.value)
      }}
    />
  )
}

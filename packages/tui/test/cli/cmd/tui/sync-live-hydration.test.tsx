/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test.each(["message.removed", "message.part.removed"] as const)(
  "%s for uncached history is a no-op without disrupting live updates",
  async (type) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      emit(
        global(
          type === "message.removed"
            ? { id: "evt_uncached_removed", type, properties: { sessionID, messageID } }
            : { id: "evt_uncached_removed", type, properties: { sessionID, messageID, partID } },
        ),
      )
      await Bun.sleep(30)
      expect(errors).not.toHaveBeenCalled()
      expect(sync.data.message[sessionID]).toBeUndefined()
      expect(sync.data.part[messageID]).toBeUndefined()

      emit(
        global({ id: "evt_live_after_removal", type: "message.updated", properties: { sessionID, info: assistant } }),
      )
      await wait(() => sync.data.message[sessionID]?.length === 1)
      expect(sync.data.message[sessionID][0].id).toBe(messageID)
    } finally {
      errors.mockRestore()
      app.renderer.destroy()
    }
  },
)

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("reopening a hydrated child recovers missed persisted text and tool parts without duplicates", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const child = { ...session, parentID: "ses_parent" }
  const user = {
    id: "msg_child_user",
    sessionID,
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "model" },
  }
  const assistantText = { ...assistant, id: "msg_child_answer", parentID: user.id, time: { created: 2, completed: 3 } }
  const assistantTools = { ...assistant, id: "msg_child_tools", parentID: user.id, time: { created: 4 } }
  let requests = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(child)
    if (url.pathname === `/session/${sessionID}/message`) {
      requests++
      if (requests === 1) return json([])
      return json([
        {
          info: user,
          parts: [{ id: "prt_child_user", sessionID, messageID: user.id, type: "text", text: "inspect" }],
        },
        {
          info: assistantText,
          parts: [{ id: "prt_child_answer", sessionID, messageID: assistantText.id, type: "text", text: "found" }],
        },
        {
          info: assistantTools,
          parts: [
            {
              id: "prt_child_done",
              sessionID,
              messageID: assistantTools.id,
              type: "tool",
              callID: "done",
              tool: "bash",
              state: {
                status: "completed",
                input: {},
                output: "ok",
                title: "bash",
                metadata: {},
                time: { start: 4, end: 5 },
              },
            },
            {
              id: "prt_child_running",
              sessionID,
              messageID: assistantTools.id,
              type: "tool",
              callID: "running",
              tool: "glob",
              state: { status: "running", input: {}, title: "glob", metadata: {}, time: { start: 5 } },
            },
          ],
        },
      ])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(sync.data.message[sessionID]).toEqual([])
    await sync.session.sync(sessionID, { reconcile: true })
    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual([
      user.id,
      assistantText.id,
      assistantTools.id,
    ])
    expect(sync.data.part[assistantText.id]?.[0]).toMatchObject({ type: "text", text: "found" })
    expect(sync.data.part[assistantTools.id]?.[0]).toMatchObject({
      type: "tool",
      state: { status: "completed", output: "ok" },
    })
    expect(sync.data.part[assistantTools.id]?.[1]).toMatchObject({ type: "tool", state: { status: "running" } })
    await sync.session.sync(sessionID, { reconcile: true })
    expect(requests).toBe(3)
    expect(sync.data.message[sessionID]).toHaveLength(3)
    expect(sync.data.part[assistantTools.id]).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test("session hydration restores pending V2 interactions", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permission = {
    id: "per_pending",
    sessionID,
    action: "external_directory",
    resources: ["/tmp/outside/*"],
  }
  const question = {
    id: "que_pending",
    sessionID,
    questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
  }
  const { app, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [permission] })
    if (url.pathname === `/api/session/${sessionID}/question`) return json({ data: [question] })
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)

    expect(sync.data.permission[sessionID]).toEqual([
      expect.objectContaining({ id: permission.id, permission: permission.action, api: "v2" }),
    ])
    expect(sync.data.question[sessionID]).toEqual([expect.objectContaining({ id: question.id, api: "v2" })])
  } finally {
    app.renderer.destroy()
  }
})

test("a missed legacy permission event is recovered while the session is working", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permission = {
    id: "per_legacy_missed",
    sessionID,
    permission: "external_directory",
    patterns: ["/tmp/outside/*"],
    always: ["/tmp/outside/*"],
    metadata: {},
  }
  let permissionLists = 0
  const running = { ...assistant, time: { created: 1 } }
  const { app, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json({ ...session, approvalMode: "normal" })
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: running, parts: [] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === "/permission") {
      permissionLists++
      return json(permissionLists === 1 ? [] : [permission])
    }
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(sync.data.permission[sessionID]).toEqual([])

    await wait(() => sync.data.permission[sessionID]?.some((request) => request.id === permission.id), 3_000)
    expect(permissionLists).toBeGreaterThanOrEqual(2)
    expect(sync.data.permission[sessionID]).toEqual([expect.objectContaining({ id: permission.id })])
  } finally {
    app.renderer.destroy()
  }
})

test.each(["working", "idle"] as const)(
  "a missed task completion event is recovered from persisted messages while locally %s",
  async (localStatus) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const running = { ...assistant, time: localStatus === "working" ? { created: 1 } : { created: 1, completed: 2 } }
    const completed = { ...assistant, time: { created: 1, completed: 2 }, finish: "stop" as const }
    const task = (status: "running" | "completed") => ({
      id: partID,
      sessionID,
      messageID,
      type: "tool" as const,
      tool: "task",
      callID: "call_task",
      state:
        status === "running"
          ? { status, input: {}, title: "subagent", metadata: {}, time: { start: 1 } }
          : { status, input: {}, output: "done", title: "subagent", metadata: {}, time: { start: 1, end: 2 } },
    })
    let messageRequests = 0
    const limits: string[] = []
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        messageRequests++
        limits.push(url.searchParams.get("limit") ?? "")
        return json([
          {
            info: messageRequests === 1 ? running : completed,
            parts: [task(messageRequests === 1 ? "running" : "completed")],
          },
        ])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      if (url.pathname === "/session/status") return json({})
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync(sessionID)
      expect(sync.data.part[messageID][0]).toMatchObject({ state: { status: "running" } })

      await wait(
        () =>
          sync.data.part[messageID]?.[0]?.type === "tool" && sync.data.part[messageID][0].state.status === "completed",
        3_500,
      )

      expect(messageRequests).toBe(2)
      expect(limits).toEqual(["100", "10"])
      expect(sync.data.message[sessionID][0]).toMatchObject({ time: { completed: 2 } })
      expect(sync.data.session_status[sessionID]).toEqual({ type: "idle" })
    } finally {
      app.renderer.destroy()
    }
  },
)

test("message reconciliation preserves a newer live completion event", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const running = { ...assistant, time: { created: 1 } }
  const stale = {
    id: partID,
    sessionID,
    messageID,
    type: "tool" as const,
    tool: "task",
    callID: "call_task",
    state: { status: "running" as const, input: {}, title: "subagent", metadata: {}, time: { start: 1 } },
  }
  let resolveReconciliation!: (response: Response) => void
  const reconciliation = new Promise<Response>((resolve) => {
    resolveReconciliation = resolve
  })
  let messageRequests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      messageRequests++
      if (messageRequests === 1) return json([{ info: running, parts: [stale] }])
      return reconciliation
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === "/session/status") return json({})
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    await wait(() => messageRequests === 2, 3_500)
    emit(
      global({
        id: "evt_task_completed",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: {
            ...stale,
            state: {
              status: "completed",
              input: {},
              output: "live completion",
              title: "subagent",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        },
      }),
    )
    resolveReconciliation(json([{ info: running, parts: [stale] }]))

    await wait(() => sync.data.session_status[sessionID]?.type === "idle")
    expect(sync.data.part[messageID][0]).toMatchObject({
      state: { status: "completed", output: "live completion" },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("server reconnection immediately refreshes a missed Task completion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const running = { ...assistant, time: { created: 1 } }
  const completed = { ...assistant, time: { created: 1, completed: 2 }, finish: "stop" as const }
  const task = (status: "running" | "completed") => ({
    id: partID,
    sessionID,
    messageID,
    type: "tool" as const,
    tool: "task",
    callID: "call_task",
    state:
      status === "running"
        ? { status, input: {}, title: "subagent", metadata: {}, time: { start: 1 } }
        : { status, input: {}, output: "done", title: "subagent", metadata: {}, time: { start: 1, end: 2 } },
  })
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requests++
      return json([
        {
          info: requests === 1 ? running : completed,
          parts: [task(requests === 1 ? "running" : "completed")],
        },
      ])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect("completed" in sync.data.message[sessionID][0].time).toBe(false)
    expect(sync.data.part[messageID][0]).toMatchObject({ state: { status: "running" } })
    emit(global({ id: "evt_reconnected", type: "server.connected", properties: {} }))
    await wait(() => {
      const time = sync.data.message[sessionID]?.[0]?.time
      return !!time && "completed" in time && time.completed === 2
    }, 1_000)
    expect(requests).toBe(2)
    expect(sync.data.part[messageID][0]).toMatchObject({ state: { status: "completed" } })
  } finally {
    app.renderer.destroy()
  }
})

test("resolved V2 interactions are not resurrected by stale hydration", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permission = {
    id: "per_resolved",
    sessionID,
    action: "external_directory",
    resources: ["/tmp/outside/*"],
  }
  let resolvePermissions!: (response: Response) => void
  const permissions = new Promise<Response>((resolve) => {
    resolvePermissions = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/permission`) {
      requested = true
      return permissions
    }
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_permission_replied",
        type: "permission.v2.replied",
        properties: { sessionID, requestID: permission.id, reply: "once" },
      }),
    )
    resolvePermissions(json({ data: [permission] }))
    await hydrate

    expect(sync.data.permission[sessionID]).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("session hydration auto-approves pending V2 permissions", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permission = {
    id: "per_auto_pending",
    sessionID,
    action: "external_directory",
    resources: ["/tmp/outside/*"],
  }
  const replies: Request[] = []
  const { app, sync } = await mount((url, request) => {
    if (url.pathname === `/session/${sessionID}`) return json({ ...session, approvalMode: "auto" })
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [permission] })
    if (url.pathname === `/api/session/${sessionID}/permission/${permission.id}/reply`) {
      replies.push(request)
      return new Response(null, { status: 204 })
    }
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)

    expect(replies).toHaveLength(1)
    expect(await replies[0]!.clone().json()).toEqual({ reply: "once" })
    expect(sync.data.permission[sessionID]).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("live and hydrated auto permissions share one reply", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const permission = {
    id: "per_auto_race",
    sessionID,
    action: "external_directory",
    resources: ["/tmp/outside/*"],
  }
  let resolvePermissions!: (response: Response) => void
  const permissions = new Promise<Response>((resolve) => {
    resolvePermissions = resolve
  })
  const replies: Request[] = []
  let requested = false
  const { app, emit, sync } = await mount((url, request) => {
    if (url.pathname === `/session/${sessionID}`) return json({ ...session, approvalMode: "auto" })
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/permission`) {
      requested = true
      return permissions
    }
    if (url.pathname === `/api/session/${sessionID}/permission/${permission.id}/reply`) {
      replies.push(request)
      return new Response(null, { status: 204 })
    }
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_auto_permission_race",
        type: "permission.v2.asked",
        properties: permission,
      }),
    )
    resolvePermissions(json({ data: [permission] }))
    await hydrate
    await wait(() => replies.length === 1)
    await Bun.sleep(30)

    expect(replies).toHaveLength(1)
    expect(sync.data.permission[sessionID]).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("a projection committed by another process refreshes an already loaded session", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let text = "before sync"
  let messageRequests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      messageRequests++
      return json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text }] }])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "before sync" })
    text = "after sync"
    emit(global({ id: "evt_projection", type: "sync.projection.updated", properties: { revision: 1 } }))
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "after sync",
    )
    expect(messageRequests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
      }),
    )
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "hydrated" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test("live messages merged during hydration retain the 100 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

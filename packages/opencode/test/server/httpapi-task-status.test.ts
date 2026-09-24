import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Task status HttpApi capability boundary", () => {
  test("legacy adapter returns explicit unsupported without resolving a target", async () => {
    await using tmp = await tmpdir({ git: true })
    for (const [route, body] of [
      ["status", { target: { task_id: "ses_hidden" } }],
      [
        "send",
        {
          target: {
            task_id: "ses_hidden",
            invocation: {
              parent_session_id: "ses_missing",
              parent_message_id: "msg_parent",
              call_id: "call-task",
            },
            input_id: "msg_input",
          },
          operation_id: "send-1",
          text: "steer",
        },
      ],
      [
        "reconcile",
        {
          target: {
            task_id: "ses_hidden",
            invocation: {
              parent_session_id: "ses_missing",
              parent_message_id: "msg_parent",
              call_id: "call-task",
            },
            input_id: "msg_input",
          },
          operation_id: "reconcile-1",
          disposition: "cancel_pending",
        },
      ],
    ] as const) {
      const response = await HttpApiApp.webHandler().handler(
        new Request(`http://localhost/api/session/ses_missing/task/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify(body),
        }),
        Context.empty() as Context.Context<unknown>,
      )
      expect(response.status, await response.clone().text()).toBe(503)
      expect(await response.text()).toContain("task_control_unsupported")
    }
  })

  test("complete capability fixture lists only direct children and hides foreign targets", async () => {
    await using tmp = await tmpdir({ git: true })
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.createRoutes(undefined, {
        id: "session_v2",
        features: new Set<SessionTaskCapability.Feature>([
          "atomic_admission",
          "exact_owner_guard",
          "durable_queue",
          "reconcile",
          "exact_cancellation",
          "exact_result",
          "notification",
        ]),
      }),
      { disableLogger: true },
    )
    const request = (route: string, body: unknown) =>
      handler.handler(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify(body),
        }),
        Context.empty() as Context.Context<unknown>,
      )
    const create = async (parentID?: string) => {
      const response = await request("/session", parentID ? { parentID } : {})
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as { id: string }
    }
    const parent = await create()
    const child = await create(parent.id)
    const sibling = await create(parent.id)
    const foreignParent = await create()
    const foreign = await create(foreignParent.id)
    const list = await request(`/api/session/${parent.id}/task/status`, {})
    expect(list.status, await list.clone().text()).toBe(200)
    expect(
      new Set(
        ((await list.json()) as { data: { target: { task_id: string } }[] }).data.map((item) => item.target.task_id),
      ),
    ).toEqual(new Set([child.id, sibling.id]))
    const first = await request(`/api/session/${parent.id}/task/status`, { limit: 1 })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstPage = (await first.json()) as { data: { target: { task_id: string } }[]; next?: string }
    expect(firstPage.data).toHaveLength(1)
    expect(firstPage.next).toBeTruthy()
    const second = await request(`/api/session/${parent.id}/task/status`, { limit: 1, cursor: firstPage.next })
    expect(second.status, await second.clone().text()).toBe(200)
    const secondPage = (await second.json()) as { data: { target: { task_id: string } }[]; next?: string }
    expect(secondPage.data).toHaveLength(1)
    expect(secondPage.next).toBeUndefined()
    expect(new Set([firstPage.data[0]?.target.task_id, secondPage.data[0]?.target.task_id])).toEqual(
      new Set([child.id, sibling.id]),
    )
    const invalid = await request(`/api/session/${parent.id}/task/status`, { cursor: `${firstPage.next}x` })
    expect(invalid.status).toBe(400)
    const hidden = await request(`/api/session/${parent.id}/task/status`, { target: { task_id: foreign.id } })
    const missing = await request(`/api/session/${parent.id}/task/status`, { target: { task_id: "ses_missing" } })
    const forged = await request(`/api/session/${parent.id}/task/status`, {
      target: {
        task_id: child.id,
        invocation: { parent_session_id: foreignParent.id, parent_message_id: "msg_fake", call_id: "call_fake" },
      },
    })
    const mixed = await request(`/api/session/${parent.id}/task/status`, {
      targets: [{ task_id: child.id }, { task_id: foreign.id }],
    })
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(hidden.status)
    const hiddenBody = await hidden.text()
    expect(await missing.text()).toBe(hiddenBody)
    expect(forged.status).toBe(hidden.status)
    expect(await forged.text()).toBe(hiddenBody)
    expect(mixed.status).toBe(hidden.status)
    expect(await mixed.text()).toBe(hiddenBody)
    for (const route of ["send", "reconcile"] as const) {
      const payload = (taskID: string) => ({
        target: {
          task_id: taskID,
          input_id: "msg_missing",
          invocation: {
            parent_session_id: parent.id,
            parent_message_id: "msg_parent",
            call_id: "call-task",
          },
        },
        operation_id: `operation-${route}`,
        ...(route === "send" ? { text: "steer" } : { disposition: "cancel_pending" }),
      })
      const unknown = await request(`/api/session/${parent.id}/task/${route}`, payload("ses_missing"))
      const forbidden = await request(`/api/session/${parent.id}/task/${route}`, payload(foreign.id))
      expect(unknown.status, await unknown.clone().text()).toBe(404)
      expect(forbidden.status).toBe(unknown.status)
      expect(await forbidden.text()).toBe(await unknown.text())
    }
  })
})

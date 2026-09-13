/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onCleanup, type ParentProps } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider, useKV } from "../../../src/context/kv"
import { RemoteStatusProvider } from "../../../src/context/remote-status"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource, json } from "../../fixture/tui-sdk"

const targetID = "target-test"
const request: QuestionRequest = {
  id: "question-test",
  sessionID: "session-test",
  questions: [
    {
      header: "Choice",
      question: "Choose one",
      options: [{ label: "First", description: "First choice" }],
      custom: false,
    },
  ],
}

function Ready(props: ParentProps<{ onReady: () => void }>) {
  const kv = useKV()
  createEffect(() => {
    if (kv.ready) props.onReady()
  })
  return <>{props.children}</>
}

async function mountQuestion(input: { root: string; fail?: boolean; local?: boolean }) {
  await mkdir(path.join(input.root, "state"), { recursive: true })
  await Bun.write(path.join(input.root, "state", "kv.json"), "{}")
  const calls: Request[] = []
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const fetch = (async (value: RequestInfo | URL, init?: RequestInit) => {
    const current = value instanceof Request && !init ? value : new Request(value, init)
    calls.push(current)
    if (input?.fail)
      return json({ name: "QuestionNotFoundError", data: { message: "Question request not found" } }, { status: 404 })
    return json(true)
  }) as typeof globalThis.fetch

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const unregister = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(unregister)
    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state: path.join(input.root, "state") }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <Ready onReady={resolveReady}>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <RemoteStatusProvider>
                      <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                        <QuestionPrompt
                          request={request}
                          location={
                            input.local
                              ? {
                                  directory: "/Users/test/project",
                                  workspaceID: "workspace-test",
                                  target: { type: "local" },
                                }
                              : {
                                  directory: "/home/test/project",
                                  target: { type: "rexd", targetID },
                                }
                          }
                        />
                        <Toast />
                      </SDKProvider>
                    </RemoteStatusProvider>
                  </ToastProvider>
                </ThemeProvider>
              </Ready>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 20, kittyKeyboard: true })
  await ready
  await app.renderOnce()
  await Bun.sleep(10)
  return { app, calls }
}

test("Enter routes a Rexd question reply through its target", async () => {
  await using tmp = await tmpdir()
  const question = await mountQuestion({ root: tmp.path })
  try {
    question.app.mockInput.pressEnter()
    await question.app.waitFor(() => question.calls.length === 1)
    expect(new URL(question.calls[0]!.url).pathname).toBe("/question/question-test/reply")
    expect(question.calls[0]!.headers.get("x-opencode-target")).toBe(targetID)
    expect(new URL(question.calls[0]!.url).searchParams.has("directory")).toBe(false)
  } finally {
    question.app.renderer.destroy()
  }
})

test("Escape routes a Rexd question rejection through its target", async () => {
  await using tmp = await tmpdir()
  const question = await mountQuestion({ root: tmp.path })
  try {
    question.app.mockInput.pressEscape()
    await question.app.waitFor(() => question.calls.length === 1)
    expect(new URL(question.calls[0]!.url).pathname).toBe("/question/question-test/reject")
    expect(question.calls[0]!.headers.get("x-opencode-target")).toBe(targetID)
  } finally {
    question.app.renderer.destroy()
  }
})

test("local question replies keep directory and workspace routing", async () => {
  await using tmp = await tmpdir()
  const question = await mountQuestion({ root: tmp.path, local: true })
  try {
    question.app.mockInput.pressEnter()
    await question.app.waitFor(() => question.calls.length === 1)
    const url = new URL(question.calls[0]!.url)
    expect(question.calls[0]!.headers.has("x-opencode-target")).toBe(false)
    expect(url.searchParams.get("directory")).toBe("/Users/test/project")
    expect(url.searchParams.get("workspace")).toBe("workspace-test")
  } finally {
    question.app.renderer.destroy()
  }
})

test("question response failures are visible", async () => {
  await using tmp = await tmpdir()
  const question = await mountQuestion({ root: tmp.path, fail: true })
  try {
    question.app.mockInput.pressEnter()
    await question.app.waitFor(() => question.calls.length === 1)
    await question.app.waitFor(() => question.app.captureCharFrame().includes("Question request not found"))
  } finally {
    question.app.renderer.destroy()
  }
})

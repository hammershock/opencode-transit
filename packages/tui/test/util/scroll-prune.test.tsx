import { afterEach, describe, expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComputed, createSignal, For } from "solid-js"
import { compensatePrunedScrollTop } from "../../src/util/scroll"

type Message = {
  id: string
  lines: number
}

describe("session scroll pruning", () => {
  let app: Awaited<ReturnType<typeof testRender>> | undefined

  afterEach(() => app?.renderer.destroy())

  function fixture() {
    const [messages, setMessages] = createSignal(
      Array.from({ length: 100 }, (_, index) => ({ id: String(index), lines: index % 2 === 0 ? 2 : 4 })),
    )
    const [followOutput, setFollowOutput] = createSignal(true)
    let scroll: ScrollBoxRenderable | undefined

    const View = () => {
      createComputed(() => {
        const current = messages()
        if (!scroll || scroll.isDestroyed) return
        const next = compensatePrunedScrollTop({
          children: scroll.getChildren(),
          messageIDs: new Set(current.map((message) => message.id)),
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
          viewportHeight: scroll.viewport.height,
        })
        if (next === undefined) return
        setFollowOutput(false)
        scroll.scrollTop = next
      })
      return (
        <scrollbox
          ref={(value) => (scroll = value)}
          width={50}
          height={15}
          stickyScroll={followOutput()}
          stickyStart="bottom"
        >
          <box height={1} />
          <For each={messages()}>
            {(message) => (
              <box id={message.id} flexShrink={0}>
                <box marginTop={1} flexShrink={0}>
                  <For each={Array.from({ length: message.lines }, (_, index) => index)}>
                    {(line) => <text>{`${message.id}:${line}`}</text>}
                  </For>
                </box>
              </box>
            )}
          </For>
        </scrollbox>
      )
    }

    return {
      View,
      messages,
      setMessages,
      setFollowOutput,
      scroll: () => scroll!,
    }
  }

  test("keeps a visible message on the same row across mixed-height prunes", async () => {
    const view = fixture()
    app = await testRender(() => <view.View />, { width: 80, height: 24 })
    await app.renderOnce()

    view.scroll().scrollBy(-10)
    view.setFollowOutput(false)
    await app.renderOnce()
    const anchor = view
      .scroll()
      .getChildren()
      .filter((child) => child.id !== undefined && child.y >= 0)
      .toSorted((a, b) => a.y - b.y)[0]
    expect(anchor).toBeDefined()

    for (let index = 100; index < 106; index++) {
      view.setMessages((messages) => [...messages.slice(1), { id: String(index), lines: index % 2 === 0 ? 2 : 4 }])
      await app.renderOnce()
    }

    expect(
      view
        .scroll()
        .getChildren()
        .find((child) => child.id === anchor!.id)?.y,
    ).toBe(anchor!.y)
  })

  test("continues following pruned messages while already at the bottom", async () => {
    const view = fixture()
    app = await testRender(() => <view.View />, { width: 80, height: 24 })
    await app.renderOnce()

    view.setMessages((messages) => [...messages.slice(1), { id: "100", lines: 8 }])
    await app.renderOnce()

    expect(view.scroll().scrollTop).toBe(view.scroll().scrollHeight - view.scroll().viewport.height)
  })

  test("does not re-engage sticky bottom when a tall oldest message is pruned", async () => {
    const view = fixture()
    view.setMessages((messages) => [{ ...messages[0]!, lines: 20 }, ...messages.slice(1)])
    app = await testRender(() => <view.View />, { width: 80, height: 24 })
    await app.renderOnce()

    view.scroll().scrollBy(-5)
    view.setFollowOutput(false)
    await app.renderOnce()
    const anchor = view
      .scroll()
      .getChildren()
      .filter((child) => child.id !== undefined && child.y >= 0)
      .toSorted((a, b) => a.y - b.y)[0]!

    view.setMessages((messages) => [...messages.slice(1), { id: "100", lines: 2 }])
    await app.renderOnce()

    expect(
      view
        .scroll()
        .getChildren()
        .find((child) => child.id === anchor.id)?.y,
    ).toBe(anchor.y)
    view.setMessages((messages) => [...messages, { id: "101", lines: 4 }])
    await app.renderOnce()

    expect(
      view
        .scroll()
        .getChildren()
        .find((child) => child.id === anchor.id)?.y,
    ).toBe(anchor.y)
  })

  test("keeps a historical row fixed when a peer activity arrives above it", async () => {
    const [rows, setRows] = createSignal(Array.from({ length: 40 }, (_, index) => String(index)))
    const [followOutput, setFollowOutput] = createSignal(false)
    let scroll: ScrollBoxRenderable | undefined
    const View = () => {
      createComputed(() => {
        const current = rows()
        if (!scroll || scroll.isDestroyed || followOutput() || current.length === 0) return
        const anchor = scroll.getChildren().find((child) => child.id && child.y + child.height > 0)
        if (!anchor?.id) return
        const oldY = anchor.y
        setTimeout(() => {
          if (!scroll || scroll.isDestroyed || followOutput()) return
          const moved = scroll.getChildren().find((child) => child.id === anchor.id)
          if (moved) scroll.scrollTop += moved.y - oldY
        }, 0)
      })
      return (
        <scrollbox ref={(value) => (scroll = value)} width={50} height={15} stickyScroll={followOutput()}>
          <For each={rows()}>
            {(row) => (
              <box id={row} flexShrink={0}>
                <text>{row}</text>
              </box>
            )}
          </For>
        </scrollbox>
      )
    }
    app = await testRender(() => <View />, { width: 80, height: 24 })
    await app.renderOnce()
    scroll!.scrollTo(20)
    await app.renderOnce()
    const before = scroll!.getChildren().find((child) => child.id === "20")!.y

    setRows((current) => [...current.slice(0, 10), "peer-event", ...current.slice(10)])
    await app.renderOnce()
    await Bun.sleep(10)
    await app.renderOnce()

    expect(scroll!.getChildren().find((child) => child.id === "20")!.y).toBe(before)
  })
})

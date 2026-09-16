import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core"

export type ScrollConfig = {
  scroll_acceleration?: { enabled?: boolean }
  scroll_speed?: number
}

export class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

export function getScrollAcceleration(tuiConfig?: ScrollConfig): ScrollAcceleration {
  if (tuiConfig?.scroll_acceleration?.enabled) {
    return new MacOSScrollAccel()
  }
  if (tuiConfig?.scroll_speed !== undefined) {
    return new CustomSpeedScroll(tuiConfig.scroll_speed)
  }

  return new CustomSpeedScroll(3)
}

type ScrollChild = {
  id?: string
  y: number
  height: number
}

export function compensatePrunedScrollTop(input: {
  children: readonly ScrollChild[]
  messageIDs: ReadonlySet<string>
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
}) {
  if (input.scrollTop >= Math.max(0, input.scrollHeight - input.viewportHeight) - 1) return

  const messages = input.children.filter((child) => child.id !== undefined)
  const oldest = messages[0]
  if (!oldest?.id || input.messageIDs.has(oldest.id)) return

  const anchor = messages.find((child) => child.id !== undefined && input.messageIDs.has(child.id))
  if (!anchor) return

  // Measure from the transcript spacer so the compensation also includes
  // margins that disappear when the first surviving message moves up.
  const above = input.children[input.children.indexOf(oldest) - 1]
  if (!above) return

  const removedHeight = anchor.y - (above.y + above.height)
  if (removedHeight <= 0) return
  return Math.max(0, input.scrollTop - removedHeight)
}

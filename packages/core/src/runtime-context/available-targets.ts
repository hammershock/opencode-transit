import { TargetRegistry } from "../target-registry"

export const MAX_AVAILABLE_TARGETS_BYTES = 8 * 1024

const FIELD_LIMIT = 512
const TRUNCATION = "…"

const PRIMARY_GUIDANCE = [
  "Available targets are advisory discovery only; they do not authorize placement or assert availability or capability.",
  'To read CACHED connection/health status (where "unknown" is valid), call slash_command({ command: "/target list" }).',
  'To place a subagent, pass target (a selector like "local" or a stable target ID) and/or an absolute directory to the Task tool; preflight re-validates the target identity and directory before the child is created.',
].join("\n")

const CHILD_GUIDANCE = [
  "You are a subagent and cannot invoke slash_command; cached target status is read by the primary agent via /target list.",
  'If the Task tool is available to you, you may place a nested subagent by passing target (a selector like "local" or a stable target ID) and/or an absolute directory; preflight re-validates the target identity and directory before the child is created.',
].join("\n")

export type AvailableTargetsInput =
  | { readonly kind: "ok"; readonly snapshot: TargetRegistry.Snapshot }
  | { readonly kind: "error" }

export function escapeField(value: string): string {
  return value.replace(/[&<>]|[\u0000-\u001f\u007f]/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === "\n") return "\\n"
    if (char === "\r") return "\\r"
    if (char === "\t") return "\\t"
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
}

function clip(value: string): string {
  return value.length <= FIELD_LIMIT ? value : value.slice(0, FIELD_LIMIT) + TRUNCATION
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function renderTarget(selector: string, name: string, description?: string): string {
  return [
    "  <target>",
    `    <selector>${escapeField(selector)}</selector>`,
    `    <name>${escapeField(clip(name))}</name>`,
    ...(description === undefined ? [] : [`    <description>${escapeField(clip(description))}</description>`]),
    "  </target>",
  ].join("\n")
}

export function renderAvailableTargets(input: AvailableTargetsInput, isChild: boolean): string {
  const header = `${isChild ? CHILD_GUIDANCE : PRIMARY_GUIDANCE}\n<available-targets>`
  const footer = "</available-targets>"
  const budget = MAX_AVAILABLE_TARGETS_BYTES - byteLength(header) - byteLength(footer) - 1

  const lines: string[] = []
  let used = 0
  const push = (text: string, reserve = 0): boolean => {
    const cost = byteLength(text) + 1
    if (used + cost + reserve > budget) return false
    lines.push(text)
    used += cost
    return true
  }

  if (input.kind === "error") {
    push("  <unavailable>target registry is unavailable</unavailable>")
    return [header, ...lines, footer].join("\n")
  }

  const snapshot = input.snapshot
  if (!snapshot.valid) {
    push("  <invalid-registry>")
    for (const diagnostic of snapshot.diagnostics) {
      if (!push(`    <diagnostic>${escapeField(clip(`${diagnostic.path}: ${diagnostic.message}`))}</diagnostic>`)) break
    }
    push("  </invalid-registry>")
    return [header, ...lines, footer].join("\n")
  }

  const registered = [...snapshot.targets].toSorted((a, b) => a.id.localeCompare(b.id))
  const omittedMarker = (count: number) => `  <!-- ${count} additional target(s) omitted -->`
  // Reserve room for the omission marker up front so it is emitted even when the
  // catalog fills the budget to the final byte.
  const markerReserve = registered.length > 0 ? byteLength(omittedMarker(registered.length)) + 1 : 0

  push(renderTarget("local", "local"), markerReserve)
  let index = 0
  for (; index < registered.length; index++) {
    const target = registered[index]
    const reserve = index < registered.length - 1 ? markerReserve : 0
    if (!push(renderTarget(target.id, target.name, target.description), reserve)) break
  }
  const omitted = registered.length - index
  if (omitted > 0) push(omittedMarker(omitted))
  return [header, ...lines, footer].join("\n")
}

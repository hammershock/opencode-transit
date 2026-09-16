export * as HarnessInstructions from "./instructions"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser"
import { Harness } from "@opencode-ai/schema/harness"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { AbsolutePath } from "../schema"
import { Flock } from "../util/flock"

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "HarnessInstructions.RevisionConflictError",
  { expected: Harness.Revision, actual: Harness.Revision },
) {}

export class InvalidConfigError extends Schema.TaggedErrorClass<InvalidConfigError>()(
  "HarnessInstructions.InvalidConfigError",
  { diagnostics: Schema.Array(Harness.InstructionSettingsDiagnostic) },
) {}

export class InvalidReferenceError extends Schema.TaggedErrorClass<InvalidReferenceError>()(
  "HarnessInstructions.InvalidReferenceError",
  { reference: Schema.String },
) {}

export interface Interface {
  readonly list: () => Promise<Harness.InstructionSettingsSnapshot>
  readonly read: (scope: Harness.InstructionScope) => Promise<Harness.InstructionRead>
  readonly resetGlobal: (expectedRevision: Harness.Revision) => Promise<Harness.InstructionSettingsSnapshot>
  readonly bind: (input: Harness.InstructionBindInput) => Promise<Harness.InstructionSettingsSnapshot>
  readonly unbind: (input: Harness.InstructionTargetMutationInput) => Promise<Harness.InstructionSettingsSnapshot>
  readonly validate: (reference: string) => Promise<Harness.InstructionSource>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HarnessInstructions") {}

type ConfigFile = {
  readonly text: string
  readonly value?: Record<string, unknown>
  readonly diagnostics: readonly Harness.InstructionSettingsDiagnostic[]
}

type Decoded = {
  readonly global?: string
  readonly targets: readonly Harness.InstructionBinding[]
  readonly diagnostics: readonly Harness.InstructionSettingsDiagnostic[]
}

export function make(options: {
  readonly directory: string
  readonly home: string
  readonly claudeFallback?: boolean
  readonly lockDirectory?: string
}) {
  const filepath = path.join(options.directory, "harness.jsonc")

  const resolve = (reference: string) => {
    validateReference(reference)
    if (reference === "~") return path.resolve(options.home)
    if (reference.startsWith("~/")) return path.resolve(options.home, reference.slice(2))
    if (path.isAbsolute(reference)) return path.normalize(reference)
    return path.resolve(options.directory, reference)
  }

  const list = async () => {
    const config = await readConfig(filepath)
    const decoded = decode(config.value)
    const diagnostics = [...config.diagnostics, ...decoded.diagnostics]
    return Harness.InstructionSettingsSnapshot.make({
      version: 1,
      path: AbsolutePath.make(filepath),
      revision: revision(config.text),
      global: decoded.global,
      targets: decoded.targets,
      diagnostics,
      valid: diagnostics.length === 0,
    })
  }

  const source = async (
    reference: string,
    snapshot: Harness.InstructionSettingsSnapshot,
  ): Promise<Harness.InstructionSource> => {
    const resolved = resolve(reference)
    const sharedTargets = snapshot.targets
      .filter((binding) => resolve(binding.reference) === resolved)
      .map((binding) => binding.target)
      .toSorted()
    const content = await fs.readFile(resolved, "utf8").then(
      (value) => ({ status: "readable" as const, content: value, size: Buffer.byteLength(value) }),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT"
          ? { status: "missing" as const, diagnostic: "Configured instruction file does not exist" }
          : {
              status: "unreadable" as const,
              diagnostic: `Configured instruction file is unreadable (${error.code ?? "IO"})`,
            },
    )
    return Harness.InstructionSource.make({
      reference,
      resolved: AbsolutePath.make(resolved),
      ...content,
      sharedTargets,
    })
  }

  const validate = async (reference: string) => source(reference, await list())

  const read = async (scope: Harness.InstructionScope): Promise<Harness.InstructionRead> => {
    const snapshot = await list()
    if (!snapshot.valid)
      return Harness.InstructionRead.make({ scope, mode: "invalid", diagnostics: snapshot.diagnostics })
    if (scope.type === "target") {
      const binding = snapshot.targets.find((item) => item.target === scope.target)
      if (!binding) return Harness.InstructionRead.make({ scope, mode: "unset", diagnostics: [] })
      return Harness.InstructionRead.make({
        scope,
        mode: "custom",
        source: await source(binding.reference, snapshot),
        diagnostics: [],
      })
    }
    if (snapshot.global)
      return Harness.InstructionRead.make({
        scope,
        mode: "custom",
        source: await source(snapshot.global, snapshot),
        diagnostics: [],
      })
    const candidates = [
      path.join(options.directory, "AGENTS.md"),
      ...(options.claudeFallback === false ? [] : [path.join(options.home, ".claude", "CLAUDE.md")]),
    ]
    for (const candidate of candidates) {
      const inspected = await source(candidate, snapshot)
      if (inspected.status === "missing") continue
      return Harness.InstructionRead.make({ scope, mode: "default", source: inspected, diagnostics: [] })
    }
    return Harness.InstructionRead.make({ scope, mode: "default", diagnostics: [] })
  }

  const mutate = async (
    expectedRevision: Harness.Revision,
    update: (text: string, snapshot: Harness.InstructionSettingsSnapshot) => string,
  ) =>
    Flock.withLock(
      `harness-instructions:${filepath}`,
      async () => {
        const before = await list()
        if (before.revision !== expectedRevision)
          throw new RevisionConflictError({ expected: expectedRevision, actual: before.revision })
        if (!before.valid) throw new InvalidConfigError({ diagnostics: before.diagnostics })
        await atomicWrite(filepath, update(await readText(filepath), before))
        return list()
      },
      { dir: options.lockDirectory },
    )

  return {
    list,
    read,
    validate,
    resetGlobal: (expectedRevision: Harness.Revision) =>
      mutate(expectedRevision, (text) => edit(text, ["instructions", "global"], undefined)),
    bind: async (input: Harness.InstructionBindInput) => {
      validateReference(input.reference)
      return mutate(input.expectedRevision, (text) =>
        edit(
          text,
          input.scope.type === "global" ? ["instructions", "global"] : ["instructions", "targets", input.scope.target],
          input.reference,
        ),
      )
    },
    unbind: (input: Harness.InstructionTargetMutationInput) =>
      mutate(input.expectedRevision, (text) => edit(text, ["instructions", "targets", input.target], undefined)),
  } satisfies Interface
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return Service.of(
      make({
        directory: global.config,
        home: global.home,
        claudeFallback: !Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT,
      }),
    )
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

async function readConfig(filepath: string): Promise<ConfigFile> {
  const result = await fs.readFile(filepath, "utf8").then(
    (text) => ({ text }),
    (error: NodeJS.ErrnoException) => ({ error }),
  )
  if ("error" in result && result.error.code !== "ENOENT")
    return {
      text: "",
      diagnostics: [
        diagnostic("invalid-config", filepath, `Harness settings are unreadable (${result.error.code ?? "IO"})`),
      ],
    }
  const text = "text" in result ? result.text : undefined
  if (text === undefined) return { text: defaultText(), value: { version: 1 }, diagnostics: [] }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(value))
    return {
      text,
      diagnostics: (errors.length ? errors : [{ error: 1, offset: 0, length: 0 }]).map((error) =>
        diagnostic(
          "invalid-config",
          filepath,
          errors.length ? printParseErrorCode(error.error) : "Root must be an object",
        ),
      ),
    }
  return { text, value, diagnostics: [] }
}

function decode(input: Record<string, unknown> | undefined): Decoded {
  if (!input) return { targets: [], diagnostics: [] }
  const diagnostics: Harness.InstructionSettingsDiagnostic[] = []
  if (input.version !== 1)
    diagnostics.push(diagnostic("unsupported-version", "version", "Harness settings version must be 1"))
  const instructions = input.instructions
  if (instructions === undefined) return { targets: [], diagnostics }
  if (!isRecord(instructions)) {
    diagnostics.push(diagnostic("invalid-config", "instructions", "Instructions settings must be an object"))
    return { targets: [], diagnostics }
  }
  const global = decodeReference(instructions.global, "instructions.global", diagnostics)
  const targets: Harness.InstructionBinding[] = []
  if (instructions.targets !== undefined && !isRecord(instructions.targets))
    diagnostics.push(diagnostic("invalid-config", "instructions.targets", "Target bindings must be an object"))
  if (isRecord(instructions.targets))
    for (const [target, value] of Object.entries(instructions.targets)) {
      if (!Schema.is(Harness.InstructionTarget)(target)) {
        diagnostics.push(diagnostic("invalid-target", `instructions.targets.${target}`, "Target identity is invalid"))
        continue
      }
      const reference = decodeReference(value, `instructions.targets.${target}`, diagnostics)
      if (reference) targets.push(Harness.InstructionBinding.make({ target, reference }))
    }
  return { global, targets: targets.toSorted((left, right) => left.target.localeCompare(right.target)), diagnostics }
}

function decodeReference(input: unknown, field: string, diagnostics: Harness.InstructionSettingsDiagnostic[]) {
  if (input === undefined) return
  if (typeof input !== "string" || !validReference(input)) {
    diagnostics.push(diagnostic("invalid-reference", field, "Instruction reference is invalid"))
    return
  }
  return input
}

function validateReference(reference: string) {
  if (!validReference(reference)) throw new InvalidReferenceError({ reference })
}

function validReference(reference: string) {
  return (
    reference.length > 0 &&
    reference === reference.trim() &&
    !/[\u0000-\u001f]/.test(reference) &&
    (!reference.startsWith("~") || reference === "~" || reference.startsWith("~/"))
  )
}

function edit(text: string, jsonPath: readonly (string | number)[], value: unknown) {
  const base = text.trim() ? text : defaultText()
  return applyEdits(base, modify(base, [...jsonPath], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
}

function defaultText() {
  return '{\n  "version": 1\n}\n'
}

async function readText(filepath: string) {
  return fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return defaultText()
    throw error
  })
}

async function atomicWrite(filepath: string, text: string) {
  await fs.mkdir(path.dirname(filepath), { recursive: true, mode: 0o700 })
  const previous = await fs.stat(filepath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: previous ? previous.mode & 0o777 : 0o600 })
    if (previous) await fs.chmod(temporary, previous.mode & 0o777)
    await fs.rename(temporary, filepath)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

function revision(text: string) {
  return Harness.Revision.make(createHash("sha256").update(text).digest("hex"))
}

function diagnostic(kind: Harness.InstructionSettingsDiagnostic["kind"], field: string, message: string) {
  return Harness.InstructionSettingsDiagnostic.make({ kind, field, message })
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

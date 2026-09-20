import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { eq } from "drizzle-orm"
import { Config } from "@opencode-ai/core/config"
import { ControllerFileSystem } from "@opencode-ai/core/controller-filesystem"
import { ModelContext } from "@opencode-ai/schema/model-context"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
  controllerFilesystemLayer?: Layer.Layer<ControllerFileSystem.Service>
  configLayer?: Layer.Layer<Config.Service>
}) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SystemContextRegistry.node, InstructionContext.node]),
    [
      [Global.node, Global.layerWith({ config: input.config })],
      [Location.node, input.locationServiceLayer],
      ...(input.filesystemLayer ? [[FSUtil.locationNode, input.filesystemLayer] as const] : []),
      ...(input.controllerFilesystemLayer
        ? [[ControllerFileSystem.node, input.controllerFilesystemLayer] as const]
        : []),
      ...(input.configLayer ? [[Config.node, input.configLayer] as const] : []),
    ],
  )

describe("InstructionContext", () => {
  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const targetFile = path.join(global, "policies", "local.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(path.dirname(targetFile), { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(targetFile, "local target")
            await fs.writeFile(
              path.join(global, "harness.jsonc"),
              JSON.stringify({ version: 1, instructions: { targets: { local: "policies/local.md" } } }),
            )
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const loadInstructions = InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const instructions = yield* loadInstructions
          expect(InstructionContext.render(instructions)).toBe(
            [
              "Instructions from: <user-config>/AGENTS.md\nglobal",
              "Instructions from: <target-instructions>\nlocal target",
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${packageFile}\npackage`,
            ].join("\n\n"),
          )
          expect(InstructionContext.render(instructions)).not.toContain("outside")
          expect(instructions).toMatchObject([
            { origin: "global-file", scope: "global" },
            { origin: "target-file", scope: "target", source: "<target-instructions>" },
            { origin: "project-file", scope: "project" },
            { origin: "project-file", scope: "project" },
          ])
        }),
      ),
    ),
  )

  it.live("uses a custom controller-global rule without falling back and preserves configured global order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "controller")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "policies"), { recursive: true })
            await fs.writeFile(path.join(global, "AGENTS.md"), "default decoy")
            await fs.writeFile(path.join(global, "policies", "global.md"), "custom global")
            await fs.writeFile(path.join(global, "configured.md"), "configured global")
            await fs.writeFile(
              path.join(global, "harness.jsonc"),
              JSON.stringify({ version: 1, instructions: { global: "policies/global.md" } }),
            )
          })
          const instructions = yield* InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
            Effect.provide(
              instructionLayer({
                config: global,
                configLayer: Layer.succeed(
                  Config.Service,
                  Config.Service.of({
                    entries: () =>
                      Effect.succeed([
                        new Config.Document({
                          type: "document",
                          path: path.join(global, "opencode.json"),
                          scope: "global",
                          filesystem: "controller",
                          info: new Config.Info({ instructions: ["configured.md"] }),
                        }),
                      ]),
                  }),
                ),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect(instructions.map((item) => [item.source, item.content])).toEqual([
            ["<global-instructions>", "custom global"],
            ["<user-config>/configured.md", "configured global"],
          ])
          expect(InstructionContext.render(instructions)).not.toContain("default decoy")
        }),
      ),
    ),
  )

  it.live("loads shared Rexd rules from controller storage and project rules from a distinct Location filesystem", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "controller")
        const project = "/remote/repo"
        const projectFile = `${project}/AGENTS.md`
        const targetProjectFile = path.join(tmp.path, "target-filesystem", "AGENTS.md")
        const targetA = Location.TargetID.make("11111111-1111-4111-8111-111111111111")
        const targetB = Location.TargetID.make("22222222-2222-4222-8222-222222222222")
        const reads: string[] = []
        const targetFS = FSUtil.Service.of({
          existsSafe: () => Effect.succeed(false),
          readFileStringSafe: (filepath: string) =>
            Effect.promise(async () => {
              reads.push(filepath)
              return filepath === projectFile ? fs.readFile(targetProjectFile, "utf8") : undefined
            }),
          resolve: (filepath: string) => Effect.succeed(filepath),
          up: () => Effect.succeed([AbsolutePath.make(projectFile)]),
          glob: () => Effect.succeed([]),
          globMatch: () => false,
        } as unknown as FSUtil.Interface)
        const load = (targetID: Location.TargetID) =>
          InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make(`ses_${targetID}`))),
            Effect.provide(
              instructionLayer({
                config: global,
                filesystemLayer: Layer.succeed(FSUtil.Service, targetFS),
                configLayer: Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      {
                        target: { type: "rexd", targetID },
                        directory: AbsolutePath.make(project),
                        lastKnownTargetName: "shared-gpu",
                      },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(targetProjectFile), { recursive: true })
            await fs.mkdir(path.join(global, "policies"), { recursive: true })
            await fs.writeFile(path.join(global, "AGENTS.md"), "controller global")
            await fs.writeFile(path.join(global, "policies", "shared.md"), "shared target")
            await fs.writeFile(
              path.join(global, "harness.jsonc"),
              JSON.stringify({
                version: 1,
                instructions: {
                  targets: { [targetA]: "policies/shared.md", [targetB]: "policies/shared.md" },
                },
              }),
            )
            await fs.writeFile(targetProjectFile, "target project")
            await fs.mkdir(path.join(global, "repo"), { recursive: true })
            await fs.writeFile(path.join(global, "repo", "AGENTS.md"), "controller project decoy")
          })

          const first = yield* load(targetA)
          const second = yield* load(targetB)
          expect(first.map((item) => [item.scope, item.source, item.content])).toEqual([
            ["global", "<user-config>/AGENTS.md", "controller global"],
            ["target", "<target-instructions>", "shared target"],
            ["project", projectFile, "target project"],
          ])
          expect(second.map((item) => [item.scope, item.source, item.content])).toEqual([
            ["global", "<user-config>/AGENTS.md", "controller global"],
            ["target", "<target-instructions>", "shared target"],
            ["project", projectFile, "target project"],
          ])
          expect(first[1]?.id).toBe(second[1]?.id)
          expect(InstructionContext.render(first)).not.toContain("controller project decoy")
          expect(reads).toEqual([projectFile, projectFile])
          expect(reads).not.toContain(path.join(global, "policies", "shared.md"))
          expect(JSON.stringify(first)).not.toContain(targetA)
          expect(JSON.stringify(second)).not.toContain(targetB)
          expect(JSON.stringify(first)).not.toContain(path.join(global, "policies"))
        })
      }),
    ),
  )

  it.live("diagnoses an unreadable configured target file with a sanitized source", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "controller")
          const targetFile = path.join(global, "unreadable")
          yield* Effect.promise(async () => {
            await fs.mkdir(targetFile, { recursive: true })
            await fs.writeFile(
              path.join(global, "harness.jsonc"),
              JSON.stringify({ version: 1, instructions: { targets: { local: "unreadable" } } }),
            )
          })
          const filesystem = FSUtil.Service.of({
            existsSafe: () => Effect.succeed(false),
            readFileStringSafe: () => Effect.succeed(undefined),
            resolve: (filepath: string) => Effect.succeed(filepath),
            up: () => Effect.succeed([]),
            glob: () => Effect.succeed([]),
            globMatch: () => false,
          } as unknown as FSUtil.Interface)
          const instructions = yield* InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
            Effect.provide(
              instructionLayer({
                config: global,
                filesystemLayer: Layer.succeed(FSUtil.Service, filesystem),
                configLayer: Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
                ),
              }),
            ),
          )

          expect(instructions).toMatchObject([
            {
              origin: "target-file",
              scope: "target",
              source: "<target-instructions>",
              status: "ignored",
              failureStage: "read",
            },
          ])
          expect(JSON.stringify(instructions)).not.toContain(targetFile)
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md available while an absent target binding preserves compatibility", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const instructions = yield* InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect(InstructionContext.render(instructions)).toBe("")
          expect(instructions).toMatchObject([{ source: file, status: "loaded", content: "" }])
          expect(instructions.some((item) => item.origin === "target-file")).toBe(false)
        }),
      ),
    ),
  )

  it.live("uses CLAUDE.md only when AGENTS.md is absent from the applicable project chain", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const directory = path.join(project, "child")
        const rootClaude = path.join(project, "CLAUDE.md")
        const childClaude = path.join(directory, "CLAUDE.md")
        const rootAgents = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(rootClaude, "root claude")
            await fs.writeFile(childClaude, "child claude")
          })
          const load = () =>
            InstructionContext.Service.pipe(
              Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
              Effect.provide(
                instructionLayer({
                  config: global,
                  locationServiceLayer: Layer.succeed(
                    Location.Service,
                    Location.Service.of(
                      location(
                        { directory: AbsolutePath.make(directory) },
                        { projectDirectory: AbsolutePath.make(project) },
                      ),
                    ),
                  ),
                }),
              ),
            )

          expect(InstructionContext.render(yield* load())).toContain(
            `Instructions from: ${rootClaude}\nroot claude`,
          )
          expect(InstructionContext.render(yield* load())).toContain(
            `Instructions from: ${childClaude}\nchild claude`,
          )
          yield* Effect.promise(() => fs.writeFile(rootAgents, "canonical"))
          const canonical = yield* load()
          expect(InstructionContext.render(canonical)).toContain(
            `Instructions from: ${rootAgents}\ncanonical`,
          )
          expect(InstructionContext.render(canonical)).not.toContain("root claude")
          expect(InstructionContext.render(canonical)).not.toContain("child claude")
        })
      }),
    ),
  )

  it.effect("resolves configured instruction files on their declaring filesystem in stable scope order", () =>
    Effect.gen(function* () {
      const reads: string[] = []
      const filesystem = (side: "controller" | "target") =>
        FSUtil.Service.of({
          existsSafe: () => Effect.succeed(false),
          readFileStringSafe: (filepath: string) =>
            Effect.sync(() => {
              reads.push(`${side}:${filepath}`)
              return side === "controller" ? "private global" : "remote project"
            }),
          resolve: (filepath: string) => Effect.succeed(filepath),
          up: () => Effect.succeed([]),
          glob: () => Effect.succeed([]),
          globMatch: () => false,
        } as unknown as FSUtil.Interface)
      const documents = [
        new Config.Document({
          type: "document",
          path: "/controller/opencode.json",
          scope: "global",
          filesystem: "controller",
          info: new Config.Info({ instructions: ["rules.md"] }),
        }),
        new Config.Document({
          type: "document",
          path: "/target/opencode.json",
          scope: "project",
          filesystem: "target",
          info: new Config.Info({ instructions: ["rules.md"] }),
        }),
      ]
      const instructions = yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/controller",
            filesystemLayer: Layer.succeed(FSUtil.Service, filesystem("target")),
            controllerFilesystemLayer: Layer.succeed(
              ControllerFileSystem.Service,
              ControllerFileSystem.Service.of(filesystem("controller")),
            ),
            configLayer: Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(documents) })),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/target") },
                  { projectDirectory: AbsolutePath.make("/target") },
                ),
              ),
            ),
          }),
        ),
      )
      expect(instructions).toMatchObject([
        { scope: "global", source: "<user-config>/rules.md", content: "private global" },
        { scope: "project", source: "/target/rules.md", content: "remote project" },
      ])
      expect(reads).toEqual(["controller:/controller/rules.md", "target:/target/rules.md"])
    }),
  )

  it.live("keeps configured glob and URL results in declaration and lexical order", () =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () => new Response("remote URL rules"),
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    ).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          const filesystem = (side: "controller" | "target") =>
            FSUtil.Service.of({
              existsSafe: () => Effect.succeed(false),
              readFileStringSafe: (filepath: string) => Effect.succeed(`${side}:${path.basename(filepath)}`),
              resolve: (filepath: string) => Effect.succeed(filepath),
              up: () => Effect.succeed([]),
              glob: () =>
                Effect.succeed(
                  side === "controller"
                    ? [AbsolutePath.make("/controller/z.md"), AbsolutePath.make("/controller/a.md")]
                    : [AbsolutePath.make("/target/z.md"), AbsolutePath.make("/target/a.md")],
                ),
              globMatch: () => false,
            } as unknown as FSUtil.Interface)
          const documents = [
            new Config.Document({
              type: "document",
              path: "/controller/opencode.json",
              scope: "global",
              filesystem: "controller",
              info: new Config.Info({ instructions: ["*.md", server.url.href] }),
            }),
            new Config.Document({
              type: "document",
              path: "/target/opencode.json",
              scope: "project",
              filesystem: "target",
              info: new Config.Info({ instructions: ["*.md"] }),
            }),
          ]
          const instructions = yield* InstructionContext.Service.pipe(
            Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
            Effect.provide(
              instructionLayer({
                config: "/controller",
                filesystemLayer: Layer.succeed(FSUtil.Service, filesystem("target")),
                controllerFilesystemLayer: Layer.succeed(
                  ControllerFileSystem.Service,
                  ControllerFileSystem.Service.of(filesystem("controller")),
                ),
                configLayer: Layer.succeed(
                  Config.Service,
                  Config.Service.of({ entries: () => Effect.succeed(documents) }),
                ),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make("/target") },
                      { projectDirectory: AbsolutePath.make("/target") },
                    ),
                  ),
                ),
              }),
            ),
          )
          expect(instructions.map((item) => [item.scope, item.source, item.content])).toEqual([
            ["global", "<user-config>/a.md", "controller:a.md"],
            ["global", "<user-config>/z.md", "controller:z.md"],
            ["global", server.url.href, "remote URL rules"],
            ["project", "/target/a.md", "target:a.md"],
            ["project", "/target/z.md", "target:z.md"],
          ])
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const instructions = yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(instructions.some((item) => item.status === "loaded")).toBe(false)
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const instructions = yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(instructions.some((item) => item.source === file && item.status === "ignored")).toBe(true)
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

      yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
            else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* InstructionContext.Service.pipe(
        Effect.flatMap((service) => service.list(SessionV2.ID.make("ses_instruction_test"))),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.live("appends nested target instructions in-memory without publishing a durable context event", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "repo")
        const child = path.join(project, "packages", "app")
        const target = path.join(child, "source.ts")
        const projectFile = path.join(project, "AGENTS.md")
        const nestedFile = path.join(child, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(child, { recursive: true })
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(nestedFile, "nested")
            await fs.writeFile(target, "content")
          })

          const sessionID = SessionV2.ID.make("ses_nested_instruction")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            const instructions = yield* InstructionContext.Service
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
              .run()
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "nested",
                directory: project,
                title: "nested",
                version: "test",
              })
              .run()

            const initial = yield* instructions.list(sessionID)
            expect(initial.some((item) => item.source === projectFile)).toBe(true)
            expect(initial.some((item) => item.source === nestedFile)).toBe(false)

            yield* instructions.extend({ sessionID, path: target, kind: "file" })
            const extended = yield* instructions.list(sessionID)
            expect(extended.some((item) => item.source === projectFile)).toBe(true)
            expect(extended.some((item) => item.source === nestedFile)).toBe(true)
            expect(
              yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
            ).toHaveLength(0)
          }).pipe(
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      {
                        projectDirectory: AbsolutePath.make(project),
                        canonicalDirectory: AbsolutePath.make(project),
                      },
                    ),
                  ),
                ),
              }),
            ),
          )
        })
      }),
    ),
  )
})

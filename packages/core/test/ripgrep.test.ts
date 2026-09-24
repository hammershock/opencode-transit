import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  it.live("rejects absolute glob filters before searching", () =>
    Effect.gen(function* () {
      const ripgrep = yield* Ripgrep.Service
      const exits = yield* Effect.all([
        Effect.exit(Effect.asVoid(ripgrep.glob({ cwd: process.cwd(), pattern: "/tmp/**/*.ts", limit: 10 }))),
        Effect.exit(Effect.asVoid(ripgrep.find({ cwd: process.cwd(), pattern: "C:\\work\\**\\*.ts", limit: 10 }))),
        Effect.exit(
          Effect.asVoid(ripgrep.grep({ cwd: process.cwd(), pattern: "needle", include: "/tmp/**/*.ts", limit: 10 })),
        ),
      ])
      exits.forEach((exit) => {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("relative to cwd")
      })
    }),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
          })

          expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("handles records above 64 KiB with bounded previews and original match offsets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "generated.txt"), `${"x".repeat(80_000)}needle\nneedle\n`),
          )
          const ripgrep = yield* Ripgrep.Service
          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
          expect(matches).toHaveLength(2)
          expect(matches[0]?.text).toBe(`${"x".repeat(2_000)}...`)
          expect(matches[0]?.submatches).toEqual([{ text: "needle", start: 80_000, end: 80_006 }])
          expect(matches[1]).toMatchObject({ line: 2, offset: 80_007, text: "needle\n" })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("bounds dense and oversized submatches without dropping matching lines", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "dense.txt"), `${"needle ".repeat(2_000)}\n`))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "wide.txt"), `${"x".repeat(80_000)}\n`))
          const ripgrep = yield* Ripgrep.Service
          const dense = yield* ripgrep.grep({ cwd: tmp.path, file: "dense.txt", pattern: "needle", limit: 10 })
          expect(dense).toHaveLength(1)
          expect(dense[0]?.submatches).toHaveLength(100)
          expect(dense[0]?.text.length).toBeLessThanOrEqual(2_003)
          const wide = yield* ripgrep.grep({ cwd: tmp.path, file: "wide.txt", pattern: "x+", limit: 10 })
          expect(wide).toHaveLength(1)
          expect(wide[0]?.submatches).toEqual([{ text: `${"x".repeat(2_000)}...`, start: 0, end: 80_000 }])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

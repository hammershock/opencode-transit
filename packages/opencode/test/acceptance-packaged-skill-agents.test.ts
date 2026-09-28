import { expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Effect } from "effect"
import { tmpdir } from "./fixture/fixture"
import { TestLLMServer } from "./lib/llm-server"

const binary = process.env.OPENCODE_PACKAGED_BINARY

test.skipIf(!binary)(
  "packaged primary cannot load a child-only Skill while its delegated child can",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const parent = (hit: { body: Record<string, unknown> }) =>
          JSON.stringify(hit.body).includes("PACKAGED_PARENT_MARKER")
        const reviewer = (hit: { body: Record<string, unknown> }) =>
          JSON.stringify(hit.body).includes("PACKAGED_CHILD_MARKER") && !parent(hit)
        yield* llm.toolMatch(parent, "skill", { name: "review-only" })
        yield* llm.toolMatch(parent, "task", {
          description: "review paper",
          prompt: "PACKAGED_CHILD_MARKER",
          subagent_type: "general",
        })
        yield* llm.toolMatch(reviewer, "skill", { name: "review-only" })
        yield* llm.textMatch(reviewer, "child completed")
        yield* llm.textMatch(parent, "parent completed")
        return yield* Effect.promise(async () => {
          await using project = await tmpdir({ git: true })
          await using runtime = await tmpdir()
          const imported = `${runtime.path}/skills`
          await Bun.write(
            `${imported}/review-only/SKILL.md`,
            "---\nname: review-only\ndescription: Child review workflow\n---\nREVIEW_BODY_PROOF",
          )
          const catalog = await Effect.runPromise(
            SkillRegistry.Service.use((registry) =>
              registry.load([
                {
                  source: { type: "directory", path: AbsolutePath.make(imported) },
                  options: { kind: "imported" },
                },
              ]),
            ).pipe(Effect.provide(AppNodeBuilder.build(SkillRegistry.node))),
          )
          const skill = catalog.snapshot.skills.find((skill) => skill.name === "review-only")!
          expect(skill).toBeDefined()
          await Bun.write(
            `${runtime.path}/.config/opencode/opencode.jsonc`,
            JSON.stringify({
              skills: { paths: [imported], agents: { [skill.id]: ["general"] } },
            }),
          )
          const databasePath = `${runtime.path}/opencode.sqlite`
          const config = {
            experimental: { background_subagents: true },
            providers: {
              test: {
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
                request: { body: { apiKey: "test-key" } },
                models: { "test-model": { api: { id: "test-model" } } },
              },
            },
          }
          await Bun.write(`${project.path}/opencode.jsonc`, JSON.stringify(config))
          const child = Bun.spawn(
            [binary!, "run", "--model", "test/test-model", "--agent", "build", "--auto", "PACKAGED_PARENT_MARKER"],
            {
              cwd: project.path,
              env: {
                ...process.env,
                OPENCODE_TEST_HOME: runtime.path,
                XDG_CONFIG_HOME: `${runtime.path}/.config`,
                XDG_CACHE_HOME: `${runtime.path}/.cache`,
                XDG_DATA_HOME: `${runtime.path}/.local/share`,
                XDG_STATE_HOME: `${runtime.path}/.local/state`,
                OPENCODE_DB: databasePath,
                OPENCODE_PURE: "1",
                OPENCODE_DISABLE_AUTOUPDATE: "1",
                OPENCODE_DISABLE_AUTOCOMPACT: "1",
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                OPENCODE_AUTH_CONTENT: "{}",
                OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          try {
            const [stdout, stderr, code] = await Promise.race([
              Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
              Bun.sleep(45_000).then(() => {
                throw new Error("packaged Task run timed out")
              }),
            ])
            if (code !== 0) throw new Error(`Packaged Skill run failed: ${stdout.slice(-2000)}\n${stderr.slice(-2000)}`)
            expect(stdout).toContain("parent completed")
            const hits = await Effect.runPromise(llm.hits)
            const primaryRequests = hits.filter(parent).map((hit) => JSON.stringify(hit.body))
            const childRequests = hits.filter(reviewer).map((hit) => JSON.stringify(hit.body))
            expect(primaryRequests.length).toBeGreaterThanOrEqual(3)
            expect(primaryRequests[0]).not.toContain("<name>review-only</name>")
            expect(primaryRequests[1]).toContain("not available in this Session")
            expect(primaryRequests.join("\n")).not.toContain("REVIEW_BODY_PROOF")
            expect(childRequests.length).toBeGreaterThanOrEqual(2)
            expect(childRequests[0]).toContain("<name>review-only</name>")
            expect(childRequests[1]).toContain("REVIEW_BODY_PROOF")
          } finally {
            child.kill()
            await child.exited
          }
        })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
    )
  },
  60_000,
)

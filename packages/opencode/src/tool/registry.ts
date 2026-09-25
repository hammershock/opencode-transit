import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionPolicyAccess } from "@opencode-ai/core/session/policy-access"
import { PermissionContext } from "@/agent/permission-context"
import { ExecutionPolicy } from "@opencode-ai/core/permission/policy"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TaskStatusTool } from "./task-status"
import { TaskSendTool } from "./task-send"
import { TaskReconcileTool } from "./task-reconcile"
import { TaskWaitTool } from "./task-wait"
import { TaskInterruptTool } from "./task-interrupt"
import { TaskStopTool } from "./task-stop"
import {
  AgentSpawnTool,
  AgentConnectTool,
  AgentInteractTool,
  AgentInspectTool,
  AgentWaitTool,
  AgentInterruptTool,
} from "./agent-tools"
import { SessionTaskCapability } from "@opencode-ai/core/session/task-capability"
import { taskBackendNode } from "@/effect/task-backend"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SlashCommandTool } from "./slash-command"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Option } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Subagent } from "../agent/subagent"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"
import { ToolJsonSchema } from "./json-schema"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel
  )
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>
type TaskStatusDef = Tool.InferDef<typeof TaskStatusTool>
type TaskWaitDef = Tool.InferDef<typeof TaskWaitTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  legacy: Record<string, Tool.Def>
  task: TaskDef
  read: ReadDef
  taskStatus: TaskStatusDef
  taskWait: TaskWaitDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly legacy: (name: string) => Effect.Effect<Tool.Def | undefined>
  readonly named: () => Effect.Effect<{
    task: TaskDef
    read: ReadDef
    taskStatus: TaskStatusDef
    taskWait: TaskWaitDef
  }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
    sessionID?: import("@/session/schema").SessionID
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const policies = yield* PermissionContext.Service
    const plugin = yield* Plugin.Service
    const subagents = Option.getOrUndefined(yield* Effect.serviceOption(Subagent.Service))
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service
    const session = yield* Session.Service
    const taskBackend = Option.getOrElse(
      yield* Effect.serviceOption(SessionTaskCapability.Service),
      () => SessionTaskCapability.legacyTaskPromptOps,
    )

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const taskStatus = yield* TaskStatusTool
    const taskSend = yield* TaskSendTool
    const taskReconcile = yield* TaskReconcileTool
    const taskWait = yield* TaskWaitTool
    const taskInterrupt = yield* TaskInterruptTool
    const taskStop = yield* TaskStopTool
    const agentSpawn = yield* AgentSpawnTool
    const agentConnect = yield* AgentConnectTool
    const agentInteract = yield* AgentInteractTool
    const agentInspect = yield* AgentInspectTool
    const agentWait = yield* AgentWaitTool
    const agentInterrupt = yield* AgentInterruptTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const slash = yield* SlashCommandTool
    const agent = yield* Agent.Service
    const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
    const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        const cfg = yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool
        const taskStatusEnabled =
          ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents) &&
          SessionTaskCapability.evaluate(taskBackend).status === "supported"
        const agentToolsEnabled = ConfigExperimental.backgroundSubagents(cfg, flags.experimentalBackgroundSubagents)

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          taskStatus: Tool.init(taskStatus),
          taskSend: Tool.init(taskSend),
          taskReconcile: Tool.init(taskReconcile),
          taskWait: Tool.init(taskWait),
          taskInterrupt: Tool.init(taskInterrupt),
          taskStop: Tool.init(taskStop),
          agentSpawn: Tool.init(agentSpawn),
          agentConnect: Tool.init(agentConnect),
          agentInteract: Tool.init(agentInteract),
          agentInspect: Tool.init(agentInspect),
          agentWait: Tool.init(agentWait),
          agentInterrupt: Tool.init(agentInterrupt),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          patch: Tool.init(patchtool),
          slash: Tool.init(slash),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          ...(codeModeTool ? { execute: Tool.init(codeModeTool) } : {}),
        })

        return {
          custom,
          legacy: {
            task: tool.task,
            task_status: tool.taskStatus,
            task_send: tool.taskSend,
            task_reconcile: tool.taskReconcile,
            task_wait: tool.taskWait,
            task_interrupt: tool.taskInterrupt,
            task_stop: tool.taskStop,
          },
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            ...(agentToolsEnabled
              ? [
                  tool.agentSpawn,
                  tool.agentConnect,
                  tool.agentInteract,
                  tool.agentInspect,
                  tool.agentWait,
                  tool.agentInterrupt,
                ]
              : [tool.task]),
            ...(!agentToolsEnabled && taskStatusEnabled ? [tool.taskStatus] : []),
            ...(!agentToolsEnabled && taskStatusEnabled
              ? [tool.taskSend, tool.taskReconcile, tool.taskWait, tool.taskInterrupt, tool.taskStop]
              : []),
            tool.fetch,
            tool.todo,
            tool.search,
            tool.patch,
            tool.slash,
            ...(tool.execute ? [tool.execute] : []),
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
          taskStatus: tool.taskStatus,
          taskWait: tool.taskWait,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const legacy: Interface["legacy"] = Effect.fn("ToolRegistry.legacy")(function* (name) {
      return (yield* InstanceState.get(state)).legacy[name]
    })

    const describeCodeMode = Effect.fn("ToolRegistry.describeCodeMode")(function* (input: {
      agent: Agent.Info
      permission?: PermissionV1.Ruleset
    }) {
      if (!codeMode) return
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const tools = Permission.visibleTools(yield* mcp.tools(), ruleset)
      if (Object.keys(tools).length === 0) return
      return codeMode.describeCatalog(tools, Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize))
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const policy = input.sessionID
        ? yield* policies.resolve(input.sessionID, input.agent.id ?? input.agent.name)
        : undefined
      const isSubagent = input.sessionID
        ? yield* session.get(input.sessionID).pipe(
            Effect.map((info) => info.parentID != null),
            Effect.catch(() => Effect.succeed(false)),
          )
        : Effect.succeed(false)
      const filtered = (yield* all()).filter((tool) => {
        const action = ["write", "apply_patch"].includes(tool.id) ? "edit" : tool.id
        if (policy && ExecutionPolicy.whollyDisabled(policy, action)) return false
        if (tool.id === SlashCommandTool.id && isSubagent) return false
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const codeModeDescription = filtered.some((tool) => tool.id === "execute")
        ? yield* describeCodeMode(input)
        : undefined
      const visible = filtered.filter((tool) => tool.id !== "execute" || codeModeDescription)

      return (yield* Effect.forEach(
        visible,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          const catalog =
            (tool.id === TaskTool.id || tool.id === AgentSpawnTool.id) && subagents
              ? yield* subagents.resolve({
                  parentAgentID: input.agent.id ?? input.agent.name,
                  sessionID: input.sessionID,
                  includeInactive: false,
                })
              : undefined
          if (catalog?.entries.length === 0) return
          return {
            id: tool.id,
            description: [output.description, tool.id === "execute" ? codeModeDescription : undefined]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema: catalog
              ? taskSchema(jsonSchema ?? ToolJsonSchema.fromSchema(output.parameters), catalog)
              : jsonSchema,
            execute:
              (tool.id === TaskTool.id || tool.id === AgentSpawnTool.id) && catalog
                ? (args: Parameters<typeof tool.execute>[0], ctx: Parameters<typeof tool.execute>[1]) =>
                    tool.execute(args, {
                      ...ctx,
                      extra: { ...ctx.extra, subagentCatalogRevision: catalog.revision },
                    })
                : tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )).filter((tool) => tool !== undefined)
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read, taskStatus: s.taskStatus, taskWait: s.taskWait }
    })

    return Service.of({ ids, all, legacy, named, tools })
  }),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    SessionPolicyAccess.node,
    PermissionContext.node,
    LocationServiceMap.node,
    SessionLocationAccess.node,
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Subagent.node,
    Session.node,
    BackgroundJob.node,
    Provider.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    MCP.node,
    Database.node,
    Ripgrep.node,
    TargetRegistry.node,
    taskBackendNode,
  ],
})

export * as ToolRegistry from "./registry"

function taskSchema(schema: JSONSchema7, catalog: Subagent.Snapshot): JSONSchema7 {
  if (schema.type !== "object" || !schema.properties) return schema
  const current = schema.properties.subagent_type
  if (typeof current !== "object" || current === null || Array.isArray(current)) return schema
  return {
    ...schema,
    properties: {
      ...schema.properties,
      subagent_type: {
        ...current,
        enum: catalog.entries.map((entry) => entry.id),
      },
    },
  }
}

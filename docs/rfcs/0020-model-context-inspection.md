---
id: 0020
title: Model Context Inspection
status: draft
authors:
  - hammershock
created: 2026-09-19
updated: 2026-09-19
implemented-by: []
depends-on:
  - 0011
  - 0012
supersedes: []
superseded-by: []
---

# RFC-0020：Model Context Inspection

## 摘要

将 `/context` 定位为**模型上下文检查工具**：一次调用忠实镜像某次真实 model request 在 opencode 统一中间态（`streamText` 输入）下传给 provider 的全部内容。当前范围 = 除正式聊天会话（`messages`）外的全部真实上下文；未来演进为包含会话消息的全面 context inspection。

同时引入 **RuntimeContext** 抽象，把「每轮动态构造、绝不进 session」的运行时上下文片段（`<available_skills>`、未来的 `<environment>` 与 `<available_slash_commands>`）统一为可注册的 part，与 durable `SystemContext` 并列；注入（`runner/llm.ts`）与展示（`/context`）共用同一 `assemble` 输出，从结构上杜绝两处 renderer 漂移。

本 RFC 是 RFC-0011 `/context` 的窄化修订，并作为 RFC-0017 的 slash catalog 与 environment runtime 化的基础抽象。设计追踪见 [#475](https://github.com/hammershock/opencode-transit/issues/475)。

## 一、术语与两类上下文

`durable` 与 `runtime` 是 harness 内部的生命周期契约，**对上游 provider 无区别**——两者最终都被压平进同一条 system prompt。它们只决定三件事：何时算值、落不落盘、内容来源。该区分仅用于给 `/context` 的每块打标签。

| | durable `SystemContext` | runtime `RuntimeContext` |
|---|---|---|
| 何时算值 | generation/activation 边界观察一次、冻结 | 每个 provider turn 现算 |
| 落盘 | 写 Context Epoch，可 resume/sync/compaction 回放 | 绝不写 session |
| 源变了是否生效 | 要等新 generation 准入 | 下一轮立即生效 |

durable 内部仍有刷新频率差异：`core/date`、`core/reference-guidance` 是 `refresh: "turn"`（每轮可翻）；`core/instructions`、`core/environment`（现状）是 `refresh: "generation"`（冻结到 rebind/`/init`）。`/context` 必须展示这一标签，帮助人看懂哪块是活的、哪块是冻结的、属于哪一代。

## 二、一次真实请求的中间态

opencode 不手写各 provider 的 HTTP wire，而是把模型解析为 AI SDK 的 `LanguageModelV3`，统一喂入：

```ts
streamText({
  system,          // [agent base system prompt, durable baseline, runtime parts...]
  messages,        // 聊天历史（本 RFC 留白）
  tools,           // tool definitions（JSON Schema）
  toolChoice,
  temperature, topP, topK,
  providerOptions, // provider 专属透传，可能含敏感标记
})
```

`system` 的装配点在 `packages/core/src/session/runner/llm.ts`：

```ts
system: [agent.info?.system, system.baseline, skillGuidance]
  .filter((part) => part !== undefined && part.length > 0)
  .map(SystemPart.make)
```

各家 provider 的 wire 只是这一中间态的不同序列化（OpenAI 的 `role:"system"`、Anthropic 顶层 `system` 字段、Gemini 的 `systemInstruction`），翻译全部在 AI SDK adapter 内。`/context` 镜像的是这份**中间态**，不复刻任何 provider wire。

## 三、RuntimeContext 抽象

定义位于 `packages/core/src/runtime-context/`：

```ts
export type Part = {
  key: string                                          // "skills" | "environment" | "slash-commands" ...
  label: string                                        // /context 面板显示名
  tag: string                                          // "<available_skills>" 等 canonical mention
  order: number
  enabled: (session, agent) => boolean                 // primary-only / location 有要求等
  render: (session, agent) => Effect<string | undefined> // 动态构造，空则省略
}
```

- `RuntimeContext.Registry.register(part)`：新增 part 只登记一处。
- `RuntimeContext.assemble(session, agent)`：按 `order` 返回有序 `[{ key, label, text }]`，是注入与展示的**唯一数据源**。
- 注入：`runner/llm.ts` 改为 `system: [agent.system, system.baseline, ...assemble.map(p => p.text)]`。
- 展示：`/context` 的 Runtime 分区显示同一 `assemble` 输出。
- 不变量收敛：`永远最新、绝不进 session` 在 RuntimeContext 一处保证，每个 part 不必各自证明。

现有 `skillGuidance` 作为首个迁入 part；未来 `environmentGuidance`、`slashGuidance` 按同一接口实现。`ReferenceGuidance` 是否从 durable 迁入 runtime 是独立决策，不在本 RFC 内。

## 四、/context 分区与交互

`/context` 面板只展示构成骨架（各块名称 + 摘要 + 来源/代际/runtime 标记），点某块进入文本查看器看原文；默认脱敏，reveal 动作 + 一次性确认后才暴露真值，关闭即清空。

```
/context（= prepared request 的一次快照）
[Request]
  model: providerID / modelID
  params: toolChoice, temperature, topP, topK
  providerOptions  ← 折叠，脱敏，reveal 才出原文
  headers          ← x-session-affinity / X-Session-Id / x-parent-session-id，同样脱敏
[system]
  1. Agent base system prompt
  2. Durable SystemContext baseline（instructions / environment / date / references）
  3. Runtime parts（<available_skills> / <environment> / <available_slash_commands>）
[tools]    工具清单 + 每条可展开 JSON Schema
[messages] 未来（本次留白）
```

交互复用 `/env list`（`component/dialog-environment.tsx`）已验证的模式：

- 外层干净列表只显示元数据，不显示值；
- 点开进入 `inspectionView` 文本查看器，值默认脱敏；
- reveal 是对话框内 action（`dialog.environment.reveal` 绑定 `r`），触发 `createEnvironmentRevealAuthorization()` 的一次性 `DialogConfirm` 确认，关闭即清空。

## 五、分层与兼容

- Core 拥有 RuntimeContext registry/assemble 与 `/context` 的 structured parts 组装；TUI 只负责面板与文本查看器。
- `/context` 的 model-context endpoint 返回 structured parts（`key`/`label`/`text`/`runtime`/`generation` 标签），与注入读同一 assemble 输出；不得各自复制 renderer。
- 公开 Protocol/HttpApi 变化后从 `packages/client` 运行 `bun run generate`。
- 本 RFC 窄化修订 RFC-0011 的 `/context` UI 描述：Location 与 instruction 的 durable 契约、context generation、refresh 与 sync 语义不变；只有「如何展示传给模型的内容」这一层被本 RFC 取代。messages 留白是显式预留，不是功能缺口。

## 非目标

- 逐 provider 复刻 HTTP wire 格式（属 AI SDK adapter 内部）。
- 聊天会话历史（`messages`）的展示，本次留白，未来演进。
- environment runtime 化与 `<available_slash_commands>` 的具体实现（作为本抽象的消费者，另由 RFC-0017 拆分 issue 交付）。
- `ReferenceGuidance` 的 durable→runtime 迁移。
- 新的指令、环境或工具加载语义；本 RFC 只改「检查/展示」层，不改「装配」层的取值与持久化语义（除 RuntimeContext 抽离本身）。

## 验收与验证

1. `/context` 一次展示 = prepared request 快照：`[Request]` + `[system]` 三块 + `[tools]`，`[messages]` 明确留白。
2. `RuntimeContext.assemble` 是注入与展示的唯一数据源，两者不各自复制 renderer。
3. 新增 runtime part 只需注册一个 producer，`runner/llm.ts` 与 `/context` 零改动。
4. durable/runtime 标签准确：冻结块显示 generation 与 refresh 频率，runtime 块标注每轮重算。
5. `providerOptions`/`headers` 默认脱敏，reveal 需一次性确认，关闭即清空，不裸印敏感值。
6. 现有 `/context` 的 instructions/environment/skill 展示能力不回归，且来源与代际信息更完整。

实现使用独立 Issue、branch、worktree 和 PR。验证包含 Core contract tests（assemble 单源、part 注册与排序、enabled 过滤）、`/context` endpoint structured parts tests、TUI 面板/文本查看器/reveal 交互 tests、受影响包 `bun typecheck`、client 生成与精确提交 clean Mac build。本 RFC 触及权限/工具入口与 session context 边界，不能使用 focused fast path；Mac 实测提供 `/context` 面板与 reveal 交互截图，local 与 Rexd Session 各一。

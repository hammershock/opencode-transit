---
id: 0018
title: Subagent Execution Destinations
status: draft
authors:
  - hammershock
created: 2026-09-19
updated: 2026-09-21
implemented-by: []
depends-on:
  - 0002
  - 0011
  - 0012
  - 0016
  - 0017
supersedes: []
superseded-by: []
---

# RFC-0018：Subagent 执行位置

## 摘要与状态

父 Agent 创建 subagent 时可传入可选 `target` 和 `directory`；二者共同构成目的 Location（`Location.Ref` 的 target + directory），先验证目的目录，再创建 child 并从自身 Location 加载环境与上下文。父 Session 保持原位置。省略参数保留同位置委派，切换 target 且省略 directory 时使用目标 target 的 `defaultDirectory`。

本 RFC 为 **Draft**，设计追踪见 [#466](https://github.com/hammershock/opencode-transit/issues/466)。**依赖 RFC-0017 Agent Slash Commands（[#464](https://github.com/hammershock/opencode-transit/issues/464)，[PR #465](https://github.com/hammershock/opencode-transit/pull/465)）完成后，才开始本能力的实现。** 设计评审可以独立进行；接受 RFC 本身不等于上游能力已交付。

主 Agent 通过前置能力的 `/target list` 获取 target 与描述，目的目录来自用户或其他上下文。每次 Task 不强制重新调用 list，但实现和交付依赖不能因此省略。

本任务只覆盖 Task 目的地参数、默认值、目录校验、child context/权限、resume 和位置展示。Slash 工具、audience/help、target description 和普通命令 Skill 由 RFC-0017 拥有。不包含父 Agent 热切换、目录自动创建、跨 target 目录探索工具、自由命令执行、workspace 复制或调度器。

## 一、Task 目的地

### 1.1 参数与身份

以下为现有 Task 参数的增量，其他参数和 RFC-0016 的 subagent identity/access 契约保持有效：

```text
TaskInput {
  ...existingFields
  target?: string
  directory?: string
}
```

`target` 接受 `local` 或 `/target list` 返回的设备本地稳定 target ID。唯一、完全同名的显示名称可以作为便利输入；解析后立即固定为 ID。`local` 为保留 selector，远端同名时必须使用 ID；禁止模糊匹配或把 host/SSH alias 当成未注册 target。target 改名不改变 child identity。

`directory` 是目的 target 上的绝对目录字符串，对应 `Location.Ref.directory`；`target` + `directory` 共同构成目的 `Location`，`directory` 本身不是完整 `Location.Ref`，也不是用户 Shell 的当前 `$PWD`。v1 不接受相对路径、`~`、环境变量或 shell 表达式展开。路径使用目标平台语义校验。

### 1.2 默认值

先解析目标 identity，再应用下表。`agent.directory` 指调用父 Session 的持久 Location directory。

| target 参数     | directory 参数 | 最终 target   | 最终 directory                  |
| --------------- | -------------- | ------------- | ------------------------------- |
| 省略            | 省略           | parent.target | parent.directory                |
| 省略            | 显式绝对路径   | parent.target | 显式路径                        |
| 与 parent 相同  | 省略           | parent.target | parent.directory                |
| 与 parent 不同  | 省略           | 指定 target   | 该 target 的 `defaultDirectory` |
| 任意有效 target | 显式绝对路径   | 指定 target   | 显式路径                        |

相等比较基于解析后的 target identity，不比较用户输入字符串。显式空字符串是错误，不视为省略。

`defaultDirectory` 是 target registry 中该 target 的默认工作目录（RFC-0002 创建 target 时默认等于探测到的远端 HOME）。它同时是 QuickStart 的初始目录建议，也是本默认值的事实来源。`defaultDirectory` 缺失、不可访问或位于 negotiated roots 外时按 1.3 校验失败，不回退到 `/`、父目录或本机 HOME。显式传入 directory 时无需为该默认值读取 defaultDirectory。

同 target 同 directory 保留既有 workspace identity；改变 target 或 directory 时不能复制父 workspaceID 来宣称同一 placement，v1 使用无显式 workspaceID 的 Location，并由目的地发现项目根。

### 1.3 校验与创建顺序

```text
检查调用者 Task 权限、subagent access 和深度
  -> 固定 target identity，计算 directory
  -> prepare target / Location services
  -> 校验连接、能力、roots、canonical path、目录存在和可访问性
  -> 在目的 Location 解析 child definition、权限、instructions 与 runtime environment guidance
  -> 重新确认 target 配置与有效访问策略未失效
  -> 创建持久化显式 Location 的 child Session
  -> 接纳 child prompt 并按 child Session ID 执行
```

校验不得调用 `mkdir`、目录创建向导或“目录不存在则创建”的 QuickStart workflow。不存在、非目录、损坏/循环 symlink、越界、无权限、未知 target、连接失败均在创建 child 之前返回明确错误；父 Task 的失败记录可以存在。symlink 保留可用逻辑路径，使用 target canonical path 校验真实包含关系。

目的目录在校验后被外部删除属于正常竞争：后续访问失败，不补建目录、不重选位置。每次 filesystem operation 仍遵守 provider 的 roots 校验。本保证针对目的地解析/校验/创建流程；成功启动后的 child 仍可在任务与权限允许时显式创建文件或目录。RFC-0002 管理的 Rexd 安装目录与已有内部运行数据保持原契约，不能借此创建缺失的实验目录。

preflight 失败不得产生可运行的 child；创建成功后的 provider/模型失败保留真实 child identity 和失败状态，不伪装成创建失败后另建 child。重试继续使用既有 invocation/idempotency 契约，不引入第二套 executor。

### 1.4 子环境、权限与结果

必须从 child Location 构造 filesystem/process、工具 registry、instruction context，以及 RFC-0017 从 durable epoch 拆出的 runtime `environmentGuidance`。该文本保持现有 `<environment>` 格式并显示 child 的 destination target/description；可选环境 Skill 指引按 child admitted catalog 解析，不能沿用 parent 的 environment 或 catalog。环境文本不写入 child Session event/part、Context Epoch、sync 或 export。控制设备全局规则按 RFC-0011 保留；父项目规则和父 `.env` 不因亲子关系复制到目的地。父提供的 task prompt 是任务内容，不能成为目的地环境事实。

subagent 先通过父 effective catalog（RFC-0016）授权，再在目的地验证同一 definition identity 可用；不能因同名改用另一个项目 Agent。目的地缺少所选定义时显式失败。最终权限保留父链 hard deny、所选 definition 和目的 Location 限制；路径权限不得把父机器上的同名路径许可直接移植到另一机器。

Task 的返回值和可见 metadata 至少记录 child Session ID、实际 target ID/名称和 directory。TUI 的 Task 卡片及 child Session 页面能看见实际位置。文件路径与结果归属于该 child Location；父 Agent 不应把远端路径当成本机路径。输出不包含连接配置、凭据或环境变量值。

### 1.5 Resume 与嵌套委派

提供 `task_id` 时先解析已有 child；省略 target/directory 是 resume 的常态，直接使用该 child 已存储的位置，不重新应用新建默认值。显式参数只允许与原位置一致；冲突返回 `task_location_mismatch`，不迁移、不新建、不向旧 child 投递 prompt。未知或不可访问 task_id 必须失败，不能退化为新建。每次 resume 继续检查调用者的现行访问权。

若现有深度与 Task 权限允许嵌套委派，child 仍可使用 Task 参数为自己的 child 选址；默认值相对于实际调用 Session。禁止 subagent 使用 slash 工具与是否允许其使用 Task 是独立规则。RFC-0015 的控制操作按 child Session ID 和实际 Location 路由，不假设 parent/child 同位置。

## 二、分层与兼容

Task 调用显式 Location 的 Session 创建 workflow，Location provider 和既有 context services 完成目标验证、instruction admission 与 runtime environment rendering。SessionExecution 保持 process-global、Session-ID based；SessionRunner、工具和权限保持 Location-scoped。不得从父捕获的服务容器解析 child prompt 文件引用、渲染 child environment 或执行 child 工具。

本 RFC 扩展 RFC-0002 的亲子选址：每个 Session 仍只有一个 Location。沿用 RFC-0011 的 instruction、RFC-0017 的 runtime environment、RFC-0012 的 Skill 和 RFC-0016 的父 effective catalog 契约，但不再将 Location 限制解释为强制同位置。RFC-0009 rebind 不变。RFC-0010 继续同步 child 自身 portable Location 与 instructions，不同步 runtime environment，也不增加 registry 或凭据同步。

RFC-0015（[PR #437](https://github.com/hammershock/opencode-transit/pull/437)）是独立控制草案，不是本 RFC 的先决条件；未来控制操作必须读取 child 自身位置。现有调用省略新参数保持同位置行为；不支持新参数的执行路径必须明确拒绝，不能静默忽略。公共 Protocol/HttpApi 变化需运行 packages/client 的 `bun run generate`。

## 三、任务与前置条件

本能力使用独立 issue、语义分支、worktree 和 PR，与 RFC-0017 分开交付。开始实现前，RFC-0017 必须已接受，其实现必须完成并满足验收；本 RFC 也必须接受，具体实现 issue 满足 Ready。**依赖方向为 #466 → #464，无反向依赖。** 后续若另开实现 issue，必须继承这一依赖并链接实际前置实现 issue/PR。

实现覆盖 Task 参数/defaults、defaultDirectory 解析、无 mkdir 校验、child creation/context/权限、resume 与实际位置显示。集成验收使用已交付的 slash 工具与普通 Skill，通过 list 了解 target，再创建 child；不在本任务重复实现命令渠道。

## 四、验收与验证

1. 默认值表每行、精确名称解析到同一 ID、空参数、远端到 local 均有 contract test；跨 target 使用 defaultDirectory。
2. Missing、非目录、无权限、symlink 越界、defaultDirectory 缺失和离线 target 均在 child 创建前失败，无 mkdir 或本地回退。
3. 显式路径无需 defaultDirectory；后续操作保持 roots 校验；外部删除目录不触发补建。
4. child 文件、shell、项目根、平台、规则、runtime environment 与 Skill guidance 来自目的地；父同名路径/规则/.env/environment/catalog 不泄漏；覆盖 workspaceID 与定义缺失场景。
5. Task 返回实际位置；resume 不重新应用默认值；冲突/未知 task_id 不创建新 child，取消/重试不重复创建。
6. 前置 slash 工具已验收；完整流程可先获取 target 描述，再创建目的地 child；child 仍无法使用 slash 工具。
7. child `environmentGuidance` 不进入 Session/sync/export；`/context` 预览同一 runtime renderer 的准确文本。

文档阶段检查格式、链接和契约。实现涉及远程执行与上下文/权限，需针对 Task/Location 的 contract 和临时数据库/filesystem integration tests、受影响包内 `bun typecheck`、必要 client generation，以及精确提交的 clean Mac build。

真实场景至少覆盖 Mac 父 Session → Linux Rexd child，两端设置不同 AGENTS.md、非敏感环境标记和同名文件，确认 child 只见目的地内容且父位置保持。检查 child `/context` 的 destination Environment preview，并确认 raw Session/export/sync payload 没有 runtime environment。再测不同已有目录、跨 target 默认 defaultDirectory、目录缺失、断连、恢复固定位置及 Task 卡片位置展示。测试仅使用隔离 Session/配置和显式测试目录。

涉及 Windows 路径、defaultDirectory 或 transport 行为时补该平台证据；变更 portable Location/亲子 sync 语义时需实际双设备验收。不得声称未测平台通过。

## 五、供评审确认的细节

- target canonical selector 为 ID/local，唯一精确名称可作便利输入；directory 只接受绝对目录。
- 跨 target 默认值为 target registry 的 defaultDirectory，而非单独探测 HOME。
- 已有深度/Task 权限允许时支持嵌套选址；subagent 的 slash 禁用仍由 RFC-0017 强制执行。

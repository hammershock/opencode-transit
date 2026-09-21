---
id: 0017
title: Agent Slash Commands
status: accepted
authors:
  - hammershock
created: 2026-09-19
updated: 2026-09-21
implemented-by: []
depends-on:
  - 0002
  - 0003
  - 0011
  - 0012
  - 0019
supersedes: []
superseded-by: []
---

# RFC-0017：Agent Slash Command

## 摘要与范围

新增独立于 bash 的 `slash_command` 工具，供顶层主 Agent 调用具备 Agent 访问资格的 slash command。命令按 User/Agent 分别配置 `audiences`，缺省 `[User]`。Agent 与 User 执行**同一份命令逻辑**，差异仅在进入上下文：User 走交互入口，Agent 走工具调用轮次；执行结果以 `stdin → stdout/stderr/code` 的工具调用格式返回。工具仅对主 Agent 开放，subagent 一律不可用；任何 Agent 调用必须明确身份为 Agent，不得伪装成 User 调用。

首批开放 `/target list` 与 `/env reload`。`/env` 主面板与 `/env init` 保持 User-only。命令发现不通过 `/slash help`，后续在 SystemPrompt 增加可用 slash command 记录块并搭配相应 Skill（见「发现与 Skill」）。

Target description 由 RFC-0019 定义并已实现，本 RFC 只消费其字段。

非目标：Target description 数据链、父 Session 热切换、远端目录发现或任意远端命令执行工具、placement grant、资源调度、自动安装 Skill，以及 SystemPrompt 记录块与配套 Skill 的落地（本 RFC 只约定其职责，不实现）。

## 一、Slash command 的受众与执行契约

### 1.1 注册与配置

在 RFC-0003 的叶子 command metadata 上增加 `audiences: (User | Agent)[]`，缺失默认 `[User]`。允许 `[User]`、`[Agent]`、`[User, Agent]` 或 `[]`。配置以稳定 command ID 为键，alias/path 不拥有独立权限；User 与 Agent 的可访问性互不推导。

Agent 可执行资格 = `audiences` 含 `Agent`，且命令能通过 Agent 进入上下文执行并返回文本结果。命令须逐条接入并通过契约验收；不能把 prompt-only、legacy-opaque 或未适配的命令简单标记为 Agent 就获得新执行能力。项目内容、Skill 和模型输入不能自行更改设备级受众授权。原有 disabled、capability deny、readOnly 和 domain permission 继续叠加生效。

执行时先按既有冲突/alias/longest-match 规则解析 winner，再对 winner 做受众校验。不因 winner 对 Agent 不可用而回退到被 shadow 的另一实现。发现与执行使用同一有效视图，防止手输或 alias 绕过。

### 1.2 工具与 actor

```text
slash_command({ command: "/target list" })
slash_command({ command: "/env reload" })
```

输入是单条 slash command 文本，按 command parser 处理；没有 shell interpolation、管道、重定向或命令串执行。`bash` 与 User Shell 不自动识别该工具语法；不复用 `session.command` 的 prompt-template 执行语义。

actor 由可信 invocation Session/agent runtime 推导，模型不能传 `actor: User`。工具仅注入顶层主 Session；任何 `parentID` 非空的子 Session 均从工具目录移除，并在执行边界再次拒绝（包括切换 Agent mode、alias、恢复旧调用或间接转发）。subagent 即使被用户打开也不获得该工具；用户本人仍使用 User 入口。

### 1.3 与 User 同一执行语义

Agent 执行的 slash command 与用户执行同一命令的行为结果一致。Agent 不是一套独立的服务端模拟，而是同一命令逻辑在 Agent 进入上下文下的一次执行。允许通过 Agent 调用的命令集合逐条集成，不承诺所有命令都无 UI；需要 UI 的命令可继续操作 UI，但最终必须把结果以工具调用格式返回。Agent 入口只负责把输入交给同一命令逻辑，并把结果按 stdout/stderr/code 返回。

### 1.4 结果契约

工具调用以 stdin → stdout/stderr/code 形式返回：

```text
CommandTextResult {
  status: completed | cancelled | failed | unknown
  stdout: string
  stderr: string
  code?: string
}
```

输出以普通工具结果返回当前模型调用，记录在该调用的 Session parts 中，不创建伪造 user prompt、不触发额外 provider call。内容按既有工具输出预算截断并明确标识；不通过隐藏 UI 状态传输结果。错误至少区分 unknown_command、audience_denied、subagent_forbidden、interaction_required、invalid_arguments、cancelled 和 domain failure。`unknown` 不等于可安全重试。

用户仍在原输入文本框输入 slash command，交互命令维持原 UI。Agent 调用参照 bash 工具卡片显示命令文本、运行/结束状态、耗时和展开后的 stdout/stderr，并明确标记为 Slash command；不填入用户输入框、不抢焦点。取消沿用当前工具 AbortSignal；不创建并行后台命令系统。

## 二、首批命令

### 2.1 `/target list`

只读叶子命令，允许 `[User, Agent]`，消费 RFC-0019 的 description 字段。输出固定文本表格或逐行记录，含稳定 selector、显示名称、description 与缓存状态（有则附时间，否则 unknown）。包含 local；local 行使用固定说明，本 RFC 不新增 local registry entry。

```text
selector       name          description                   status
local          local         Local execution target        available
<target-id>    gpu-lab       GPU experiments and evaluation unknown
```

“已配置、可选择”和“当前在线”必须区分。该命令只读 registry/既有健康缓存，不主动探测全部 target、不安装 daemon、不读远端目录、不启动 shell。后续执行消费者必须按自身契约重新校验。配置损坏产生明确诊断，不能显示成功的空列表；诊断不泄露连接信息。

User/Agent 共享相同脱敏数据与 renderer，不输出 SSH host/user/port、key path、daemon command、配置文件路径或原始 registry。用户主动填写的 description 可见，字段提示应说明这一点；renderer 对换行/终端控制字符做安全处理，采用有界长度。

`/target` 的交互管理器及 add/edit/remove 保持 User-only；开放 list 不意味着开放整个命令组。

### 2.2 `/env reload`、`/env` 与 `/env init`

`/env reload` 允许 `[User, Agent]`。User 与 Agent 执行同一 reload 语义：都不弹出 UI，只输出结果 —— User 在状态栏弹出提示，Agent 得到工具输出（stdout/code）。

`/env` 是查看环境主面板的入口，只开放给 User；打开面板查看当前环境元数据与值。`/env init` 只开放给 User，交互式初始化 `.env` 并 reload。`/env list` 命令取消，查看环境一律走 `/env` 面板。

## 三、分层与兼容

command-kit 保持 runtime-neutral，拥有 audience/parser/result 契约。命令逻辑与 User 共享；Core 负责 actor 校验与命令执行，TUI 负责 User 交互入口与展示，不能把 User 的交互回调搬到服务端当作 Agent 的模拟点击。`/target list` 消费 TargetRegistry 脱敏 projection。

本 RFC 扩展 RFC-0003 的 audience 与执行 plane，保留 User resolver 与兼容来源行为。旧 command 默认 User-only。公共 Protocol/HttpApi 变更需运行 packages/client 的 `bun run generate`；不得手写生成代码或改变 legacy `session.command` 语义。

## 四、发现与 Skill

本 RFC 不引入 `/slash help`。可用 slash command 的发现通过后续在 SystemPrompt 加入一个记录块（列出对当前 Agent 可用的 slash command），并搭配相应 Skill 指导使用。该记录块与 Skill 的落地作为独立后续任务；本 RFC 只约定：发现与执行使用同一有效视图（audiences + 解析 winner），Skill 与 target description 都不得授予执行权限，权限校验不依赖 Skill 是否加载。

## 五、任务与依赖

本能力由独立 issue、语义分支、worktree 和 PR 管理。实现包含 audience、主 Session `slash_command` 工具、`/target list` 与 `/env reload` 的 Agent 集成、`/env` 主面板与 `/env init` 的 User-only 约束、TUI 卡片，形成一个可验收的结果。依赖 RFC-0019 Target description（已实现）。

交付顺序固定为：**Agent slash command（本 RFC / #464）完成 → subagent 执行位置（RFC-0018 / #466）开始实现**。

## 六、验收与验证

1. `/target list` 消费 RFC-0019 description，无 SSH/目录调用及敏感字段。
2. audience 组合、alias/shadow、disabled/readOnly/capability deny 使用同一 resolver，手输不可绕过。
3. subagent 无工具定义且直接调用被拒绝；切换 Agent mode、恢复和间接调用不扩大权限。
4. 任何 Agent 调用以 Agent 身份执行，不能伪装 User；结果以 stdout/stderr/code 返回。
5. Agent 调用 `/env reload` 返回 reload 结果文本（stdout/code）；User 同命令只弹状态栏提示、不弹面板；两者行为语义一致。
6. `/env` 主面板与 `/env init` 对 Agent 返回 audience_denied，对 User 可用；`/env list` 已移除。
7. Agent 卡片显示 bash 风格状态和 stdout/stderr，不影响用户输入焦点；User 交互命令保持原行为。
8. 权限校验不依赖发现机制（SystemPrompt 块 / Skill）；未集成命令不能被标成 Agent 执行。
9. 无需新增 Task 目的地参数即可完成全部验收。

实现涉及权限与工具入口，不能使用 focused fast path；需要 command-kit/Core 的 parser/actor/policy contract tests、`/target list` 与 `/env reload` 的 Agent 文本结果测试、受影响包内 `bun typecheck`、client generation 和精确提交的 clean Mac build。Mac 实测 User 命令入口、主 Agent 的 list/reload 文本调用与 subagent 拒绝，提供卡片截图。

## 七、供评审确认的细节

- Agent 与 User 共享同一命令逻辑，差异仅在进入上下文；结果以 stdin → stdout/stderr/code 返回。
- `/env reload` User/Agent 都不弹 UI，User 弹状态栏提示、Agent 得工具输出。
- `/env list` 取消，`/env` 主面板与 `/env init` 仅 User。
- 发现机制延后：SystemPrompt 记录块 + 配套 Skill，不在本 RFC 实现。
- `/target list` 只读 registry 与既有缓存，不主动探测。

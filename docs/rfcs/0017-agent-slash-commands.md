---
id: 0017
title: Agent Slash Commands
status: draft
authors:
  - hammershock
created: 2026-09-19
updated: 2026-09-19
implemented-by: []
depends-on:
  - 0002
  - 0003
  - 0012
supersedes: []
superseded-by: []
---

# RFC-0017：Agent Slash Command

## 摘要与范围

新增独立于 bash 的 `slash_command` 工具，供主 Agent 调用具有 Agent 访问资格的系统 slash command。命令按 User/Agent 分别配置访问性，Agent 入口只接受纯文本输入输出且不可触发 UI。首批开放 `/target list` 与 `/slash help`；所有 subagent 均不可使用该工具。普通 Skill 介绍可用命令；target description 贯穿创建、编辑、查看和列表。

本 RFC 为 **Draft**，设计追踪见 [#464](https://github.com/hammershock/opencode-transit/issues/464)，PR 为 [#465](https://github.com/hammershock/opencode-transit/pull/465)。接受前不得开始运行时实现。

这是可以独立交付和验收的命令渠道任务。Subagent 执行位置另见 RFC-0018（[#466](https://github.com/hammershock/opencode-transit/issues/466)）；RFC-0018 依赖本能力完成，本 RFC 不依赖选址能力。Task 参数、HOME 默认值、child Location 和 resume 均不在本任务范围内。

非目标：父 Session 热切换、远端目录发现或任意远端命令执行工具、placement grant、资源调度、自动安装 Skill，以及开放其他 Agent slash command。

## 一、Target description 与文本列表

Target Input/Definition 增加可选 `description: string`。旧配置缺失等价于空描述，不因读取而重写。创建/编辑向导提供描述字段，管理列表和详情可查看与编辑，Core CRUD/JSONC 持久化保留 revision 冲突处理。描述是设备本地用户维护的用途信息，不是命令或授权，不进入 target identity，也不通过 Session sync 复制 registry。

`/target list` 是独立的只读叶子命令，允许 `[User, Agent]`。输出使用固定文本表格或逐行记录，包含可由后续消费者使用的稳定 selector、显示名称、description，以及已有缓存状态（有则附时间，否则 unknown）。包含 local；local 行使用固定说明，本 RFC 不新增 local registry entry。

```text
selector       name          description                   status
local          local         Local execution target        available
<target-id>    gpu-lab       GPU experiments and evaluation unknown
```

“已配置、可选择”和“当前在线”必须区分。该命令只读 registry/既有健康缓存，不主动探测全部 target，不安装 daemon，不读取远端目录或启动 shell。后续执行消费者必须按自身契约重新校验。配置损坏产生明确诊断，不能显示成功的空列表；诊断不泄露连接信息。

User/Agent 共享相同脱敏数据与 renderer，不输出 SSH host/user/port、key path、daemon command、配置文件路径或原始 registry。用户主动填写的 description 可见，字段提示应说明这一点；renderer 对换行/终端控制字符做安全处理，采用有界长度，避免将描述解释成指令或终端控制序列。

`/target` 的交互管理器及 add/edit/remove 等操作保持 User-only；开放 list 不意味着开放整个命令组。

## 二、Slash command 的受众与执行契约

### 2.1 注册与配置

在 RFC-0003 的叶子 command metadata 上增加 `audiences: (User | Agent)[]`，缺失默认 `[User]`。允许配置 `[User]`、`[Agent]`、`[User, Agent]` 或 `[]`。配置以稳定 command ID 为键，alias/path 不拥有独立权限；User 和 Agent 的可访问性互不推导。

Agent 执行资格还要求经过适配的 headless text handler。用户可以对支持该能力的命令选择受众，但不能通过将 UI-only、legacy-opaque 或 prompt-only command 标成 Agent 就让它获得新执行能力。项目内容、Skill 和模型输入不能自行更改设备级受众授权。原有 disabled、capability deny、readOnly 和 domain permission 继续叠加生效。

执行时先按既有冲突/alias/longest-match 规则解析 winner，再对 winner 做受众和 headless 能力校验。不因 winner 对 Agent 不可用而回退到被 shadow 的另一实现。发现、help 和执行使用同一有效视图，防止手输或 alias 绕过。

### 2.2 独立工具与无 UI 保证

```text
slash_command({ command: "/target list" })
slash_command({ command: "/slash help target list" })
```

输入是单条 slash command 文本，按 command parser 处理；没有 shell interpolation、管道、重定向或命令串执行。`bash` 与 User Shell 不自动识别该工具语法；不复用 `session.command` 的 prompt-template 执行语义。

执行主体由可信 invocation Session/agent runtime 推导，模型不能传 `actor: User`。工具仅提供给顶层主 Session；任何 `parentID` 非空的子 Session 均从工具目录中移除，并在执行边界再次拒绝，包括切换为 primary/all Agent、alias、恢复旧调用或其他工具间接转发。子 Session 即使被用户打开也不会因此获得该模型工具；用户本人仍可使用 User 入口。

Agent handler 的上下文不提供 dialog、picker、导航、editor 或确认 callback。必须在产生业务副作用前确认全部必需输入与非交互前置条件；需要补参数、确认或其他 UI 时返回 `interaction_required`/`invalid_arguments`，不能打开面板、等待点击或自动代答。若工具/domain 的现有策略要求尚未满足的人工批准，该渠道返回明确拒绝，Agent 可用普通对话说明；不因本工具调用弹出审批交互。

首批 Agent 实际可执行集合只有 `/target list` 与 `/slash help`。没有 headless adapter 的现有命令保持 User 行为；prompt command、MCP prompt、Skill slash、UI callback 不被自动桥接为 Agent command。未来新增 Agent 命令逐个注册、测试其非交互契约。

### 2.3 文本结果、错误与展示

内部结果沿用 command outcome，附纯文本输出：

```text
CommandTextResult {
  status: completed | cancelled | failed | unknown
  stdout: string
  stderr: string
  code?: string
}
```

输出以普通工具结果返回当前模型调用，记录在该调用的 Session parts 中，不创建伪造 user prompt、不触发额外 provider call。内容按既有工具输出预算截断并明确标识；不通过隐藏 UI 状态传输结果。错误至少区分 unknown_command、audience_denied、subagent_forbidden、headless_unavailable、interaction_required、invalid_arguments、cancelled 和 domain failure。`unknown` 不等于可安全重试。

用户仍在原输入文本框输入 slash command，交互命令维持原 UI。Agent 调用参照 bash 工具卡片显示命令文本、运行/结束状态、耗时和展开后的 stdout/stderr，并明确标记为 Slash command；不填入用户输入框、不抢焦点、不打开命令特有 UI。取消沿用当前工具 AbortSignal；不创建并行后台命令系统。

### 2.4 帮助注册

每个 command 可注册纯数据 help：usage、参数、默认值、示例、受众和效果说明。统一入口：

```text
/slash help
/slash help target list
/slash help slash help
```

无参数打印当前调用者可访问的命令及简要帮助；带路径打印对应 winner 的完整帮助。仅 User 可用的 UI command 也可注册帮助，User 可以打印；Agent 的 help 只列出对 Agent 可执行的命令，查询其他命令返回不可用。帮助的读取不执行被查询 command，不调用模型、不加载远程 MCP prompt、不运行 Skill 或 plugin callback。

未适配的旧 command 使用已知 metadata 提供最小帮助，并明确标识详细帮助不可用，不猜测参数与效果。group 与叶子可分别注册帮助；同一解析规则处理 alias 和冲突。`/slash help` 自身具有 help 且默认允许 `[User, Agent]`。

## 三、普通 Skill

提供可由用户按普通方式安装的 Skill 文本，介绍 slash 工具、`/slash help`、`/target list` 和错误处理。它不是内置 Skill，不自动安装、不修改默认系统 prompt，也不硬编码用户 target 或路径。Skill 按 RFC-0012 的已有发现/加载机制工作；本草案不安装 Skill。

框架不新增远端 ls、目录补全、跨 target bash 或其他目录探索工具。Skill 内容和 target description 都不能授予执行权限。后续选址任务可以扩展普通 Skill 的使用说明，但不作为本能力交付条件。

## 四、分层与兼容

command-kit 保持 runtime-neutral，拥有 audience/help/parser/result 契约。Core 拥有 actor 校验和 headless dispatch；target list 消费 TargetRegistry 脱敏 projection。Server 必要时提供类型化 adapter，TUI 负责输入和展示；不能把 UI callback 搬到服务端模拟点击。

本 RFC 扩展 RFC-0003 的 audience、帮助和受限 headless execution plane，保留 User resolver 和兼容来源行为。RFC-0002 增加 description 与只读文本列表；不改变 Session Location、RFC-0009 rebind 或 Session sync。Target description 和 registry 留在设备本地。

旧 command 默认 User-only，无 description 的配置继续可读。公共 Protocol/HttpApi 变化必须从 packages/client 运行 `bun run generate`；不得手写生成代码或改变 legacy `session.command` 的 prompt 语义。

## 五、任务与依赖

本能力由独立 issue、语义分支、worktree 和 PR 管理。实现包含 target description 全流程、audience/help、主 Session 工具、非交互执行与拒绝、TUI 卡片、`/target list` 及普通 Skill 示例，形成一个可验收的结果。

交付顺序固定为：**Agent slash command（本 RFC / #464）完成 → subagent 执行位置（RFC-0018 / #466）开始实现**。两份设计可分别评审；本能力的验收不等待 Task 选址，选址不能因“用户可以直接提供 target”而跳过依赖。实现 issue 仍须在 RFC 接受后满足 Ready 条件。

## 六、验收与验证

1. description 在创建、编辑、查看和 list 中一致；旧配置不因读取重写；list 无 SSH/目录调用及敏感字段。
2. audience 四种组合、alias/shadow、disabled/readOnly/capability deny 使用同一 resolver，手输不可绕过。
3. subagent 无工具定义且直接调用被拒绝；切换 Agent mode、恢复和间接调用不扩大权限。
4. headless handler 无 UI 服务；缺参数/确认返回文本错误且无副作用；未适配 prompt/UI command 不执行。
5. help 读取注册 metadata 而不执行 command；User/Agent 各自可见集合正确，旧命令有诚实 fallback。
6. Agent 卡片显示 bash 风格状态和纯文本输出，不影响用户输入焦点；User 交互命令保持原行为。
7. 普通 Skill 可指导主 Agent 列出帮助和 target；权限校验不依赖 Skill 是否加载。
8. 无需新增 Task 目的地参数即可完成全部验收。

文档阶段检查格式、链接、示例和一致性。实现涉及权限和工具入口，需要 command-kit/Core 的 parser/actor/policy contract tests、隔离配置中的 description CRUD integration tests、受影响包内 `bun typecheck`、必要 client generation 和精确提交的 clean Mac build。

Mac 实测 target 描述创建/编辑、User 命令入口、主 Agent 的 list/help 文本调用与 subagent 拒绝，提供卡片和表单截图。列表禁止远端 I/O 用 adapter 测试验证；本任务不要求跨 target child 执行。修改 Windows 平台路径或存储行为时追加相应证据，不声称未测平台通过。

## 七、供评审确认的细节

- `/slash help [command path]` 为集中入口；Agent 帮助只列自身可执行命令。
- 需要 UI 或人工批准的 Agent command 返回 interaction-required/denied。
- `/target list` 仅使用 registry 和已有缓存状态，不主动探测目标。

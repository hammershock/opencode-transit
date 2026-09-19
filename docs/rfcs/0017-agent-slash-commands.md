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
  - 0011
  - 0012
supersedes: []
superseded-by: []
---

# RFC-0017：Agent Slash Command

## 摘要与范围

新增独立于 bash 的 `slash_command` 工具，供主 Agent 调用具有 Agent 访问资格的系统 slash command。命令按 User/Agent 分别配置访问性，Agent 入口只接受纯文本输入输出且不可触发 UI。首批开放 `/target list` 与 `/slash help`；所有 subagent 均不可使用该工具。启动上下文明确当前 OpenCode Transit execution target，可用时引导 Agent 加载普通 Transit 指南 Skill；target description 贯穿创建、编辑、查看和列表。

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

提供可由用户按普通方式安装的环境说明 Skill，介绍 OpenCode Transit 的 Location/target 语义、slash 工具、`/slash help`、`/target list`、主 Agent 与 subagent 的能力差异及错误处理。下文以用户提出的 `$SKILL-environment` 表示它的 canonical mention；正式名称随该 Skill package 一起确定。它不是内置 Skill，不自动安装，也不硬编码用户 target 或路径。Skill 按 RFC-0012 的已有发现、target scope、Agent permission、准入与隐式 `skill` tool 契约工作；本草案不安装 Skill。

框架不新增远端 ls、目录补全、跨 target bash 或其他目录探索工具。Skill 内容和 target description 都不能授予执行权限。后续选址任务可以扩展普通 Skill 的使用说明，但不作为本能力交付条件。

### 3.1 启动上下文

当前实现已经从 Location-scoped `Location.Service` 构造以下 environment 文本，但 `SystemContext.initialize()` 随后把 `core/environment` 的值和 rendered baseline 写入 durable Context Epoch，provider request 再读取该 frozen baseline。因此当前是“按 Location 动态构造一次、随后进入 Session 持久化”，并不是 RFC-0012 `<available_skills>` 的 runtime-only 注入。

改造保持现有 renderer、字段与顺序，只把 `core/environment` 从 durable SystemContext baseline 拆出，作为与 `skillGuidance` 并列的 device-local startup context part。在 Session activation、Location rebind 和 provider request 组装时使用当前已解析 Location 构造；它不成为 message/part、Context Epoch、Session event、transcript、export、sync 或 compaction 内容。既有 Session 中的 legacy `core/environment` snapshot 保持可解码，但新的 provider request 不再从它注入环境文本，也不改写历史事件。

模型可见文本只做以下最小变化：Target 行只显示非敏感 target name；存在非空 description 时紧随其后显示；其余 Working directory、Project root、VCS 和 Platform 保持现状；环境说明 Skill 在当前 admitted catalog 中唯一可用时，于现有 `</environment>` 后增加一行指引。

```text
Execution harness: OpenCode Transit (opencode-transit)
<environment>
  Target: a100-2gpu
  Description: Huawei Modelart 2A100-gpu server
  Working directory: /home/ma-user/workspace/hanmo/research_template
  Project root: /home/ma-user/workspace/hanmo/research_template
  VCS: git
  Platform: linux-amd64
</environment>

More About environments, See $SKILL-environment
```

local 使用 `Target: local`。description 缺失或为空时完全省略该行；它来自 device-local TargetRegistry，只是用户维护的说明，不参与 target identity、权限或连接。所有动态字段使用固定 renderer 做换行和终端控制字符处理。不得增加 SSH host/IP/user/port、identity file、daemon command、controller hostname、credential、环境变量值或 transport 诊断。

`$SKILL-environment` 不在当前 admitted catalog、存在歧义、被 target scope 排除或被 Agent permission 拒绝时，省略末尾指引，不生成悬空引用。普通 Skill 必须说明 `slash_command` 只对顶层主 Session 可用；subagent 即使能加载该 Skill也不能调用该工具。未来内置化沿用相同 mention 和 renderer，具体迁移另行定义。

`/context` 的 model-context endpoint 在现有 frozen generation、`skillCatalog` 和 `skillGuidance` 旁新增 `environmentGuidance` runtime 字段。TUI 的 Environment 行预览该字段的准确文本并标记为 runtime；instructions 继续来自 durable generation。查看只读取当前已接纳/已构造的 runtime 文本，不执行 slash command、不调用模型、不写 Session。旧 generation 中的 environment 只能作为 legacy 诊断显示，不能覆盖当前 runtime preview。其他能查看实际 model startup context 的调试/API 层也必须使用同一 `environmentGuidance`，不能各自复制 renderer。

## 四、分层与兼容

command-kit 保持 runtime-neutral，拥有 audience/help/parser/result 契约。Core 拥有 actor 校验和 headless dispatch；target list 消费 TargetRegistry 脱敏 projection。Server 必要时提供类型化 adapter，TUI 负责输入和展示；不能把 UI callback 搬到服务端模拟点击。

本 RFC 扩展 RFC-0003 的 audience、帮助和受限 headless execution plane，保留 User resolver 和兼容来源行为。RFC-0002 增加 description 与只读文本列表。Environment guidance 采用 RFC-0012 已验证的 runtime startup-context 模式，但仍是独立 system part，不并入 `<available_skills>`。不改变 Session Location 或 RFC-0009 rebind。Target description 和 registry 留在设备本地。

本 RFC 对 RFC-0011 构成一项窄化修订：Location 与 instruction content 继续是 durable Session facts；只有 model-visible environment text 从 Context Epoch 拆为 runtime `environmentGuidance`。RFC-0011 中要求持久化、同步和从 frozen generation 预览 environment 的条款由 3.1 取代；instructions、context generation、refresh 与 sync 的其余契约不变。既有 durable environment 数据保持可解码但不再注入，迁移不得改写历史 Session event。

旧 command 默认 User-only，无 description 的配置继续可读。unresolved Session 不能调用模型，也不能使用 legacy environment 冒充当前环境。公共 Protocol/HttpApi 的 `modelContext` response 增加 runtime `environmentGuidance` 并兼容读取旧 generation；必须从 packages/client 运行 `bun run generate`，不得手写生成代码或改变 legacy `session.command` 的 prompt 语义。

## 五、任务与依赖

本能力由独立 issue、语义分支、worktree 和 PR 管理。实现包含 target description 全流程、audience/help、主 Session 工具、非交互执行与拒绝、TUI 卡片、`/target list`、现有 environment renderer 的 runtime 化、`/context` runtime preview、条件式 Skill 指引及普通 Skill 示例，形成一个可验收的结果。

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
9. local 与 Rexd Session 保留现有 environment 格式和字段；Target 只显示名称，非空 description 紧随其后，其他字段不改。
10. 仅当 admitted catalog 中唯一可用的环境说明 Skill 存在时显示 `$SKILL-environment` 指引；缺失、歧义、scope/permission 排除均省略且不影响启动。
11. 顶层主 Agent 加载 Skill 后能理解 slash channel；subagent 加载同一 Skill 仍无 `slash_command` 定义，直接调用也被执行边界拒绝。
12. `environmentGuidance` 从当前解析后的 Location 与 device-local target description 动态构造，不写入 Session event/part、Context Epoch、export、sync 或 compaction；legacy environment 可解码但不进入新请求。
13. `/context` 与其他 model-context 查看层返回并预览同一 renderer 的 `environmentGuidance`，标记 runtime；不复制格式或用旧 generation 覆盖。

文档阶段检查格式、链接、示例和一致性。实现涉及权限、工具入口与 Session context persistence 边界，不能使用 focused fast path；需要 command-kit/Core 的 parser/actor/policy contract tests、environment renderer/provider lowering tests、旧 context event migration与 sync exclusion tests、`/context` inspector tests、隔离配置中的 description CRUD integration tests、受影响包内 `bun typecheck`、client generation 和精确提交的 clean Mac build。

Mac 实测 target 描述创建/编辑、User 命令入口、主 Agent 的 list/help 文本调用与 subagent 拒绝，提供卡片、表单和 `/context` Environment preview 截图。分别以 local 与已有 Rexd Session 对照现有格式，覆盖有/无 description 和 Skill 指引，并确认 raw Session/export/sync payload 不新增 runtime environment。列表禁止远端 I/O 用 adapter 测试验证；本任务不要求跨 target child 执行。修改 Windows 平台路径或存储行为时追加相应证据，不声称未测平台通过。

## 七、供评审确认的细节

- `/slash help [command path]` 为集中入口；Agent 帮助只列自身可执行命令。
- 需要 UI 或人工批准的 Agent command 返回 interaction-required/denied。
- `/target list` 仅使用 registry 和已有缓存状态，不主动探测目标。
- 环境说明 Skill 的 canonical mention 暂按用户示例写作 `$SKILL-environment`，由该 Skill package 定稿；只有它在当前 admitted catalog 中唯一可用时才显示指引。
- 沿用现有 environment renderer 和 `/context` 布局，只改变数据生命周期及上述三处文本。

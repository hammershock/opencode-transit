---
id: 0017
title: Subagent Destinations and Agent Slash Commands
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
  - 0016
supersedes: []
superseded-by: []
---

# RFC-0017：Subagent 执行位置与 Agent Slash Command

## 摘要与状态

父 Agent 创建 subagent 时可以传入可选的 `target` 和 `location`，子 Session 在该位置验证成功后创建，并从自己的 Location 加载执行环境和模型上下文。父 Session 保持原 Location。省略参数保留同位置委派行为；切换 target 且省略 location 时使用目标机器实际用户 HOME。

新增独立于 bash 的 `slash_command` 工具，供主 Agent 调用具有 Agent 访问资格的系统 slash command。命令按 User/Agent 分别配置访问性，Agent 入口只接受纯文本输入输出且不可触发 UI。首批开放 `/target list` 与 `/slash help`；所有 subagent 均不可使用该工具。普通 Skill 负责向主 Agent 介绍该渠道，框架不注入额外的跨 target 目录发现能力。

本 RFC 为 **Draft**，设计追踪见 [#464](https://github.com/hammershock/opencode-transit/issues/464)。接受前不得据此开始运行时实现。

## 动机与范围

科研任务可能要求主 Agent 将实验委派到不同计算节点上的已有目录。用户或其他上下文提供目标目录；框架负责可靠执行这一选择，并保证子 Agent 所见规则、文件与环境来自实际目的地。

本 RFC 覆盖 Task 新建选址、target 描述、非交互命令入口、受众权限、帮助、普通 Skill 发现及其展示。复用已配置 target 和现有 Task/Location 权限，不新增 placement grant、资源调度器或候选位置目录。

非目标：父 Session 热切换；已有 child 迁移；跨 target 文件浏览或任意命令执行工具；自动创建工作目录；代码/数据复制、workspace replica 与一致性判定；资源预约；训练 Job 管理；新增 target 连接配置权限；内置或自动安装 Skill；开放其他 Agent slash command。

## 一、Task 目的地

### 1.1 参数与身份

以下为现有 Task 参数的增量，其他参数和 RFC-0016 的 subagent identity/access 契约保持有效：

```text
TaskInput {
  ...existingFields
  target?: string
  location?: string
}
```

`target` 接受 `local` 或 `/target list` 返回的设备本地稳定 target ID。唯一、完全同名的显示名称可以作为便利输入；解析后立即固定为 ID。`local` 为保留 selector，远端同名时必须使用 ID；禁止模糊匹配或把 host/SSH alias 当成未注册 target。target 改名不改变 child identity。

`location` 是目的 target 上的绝对目录字符串，对应 `Location.Ref.directory`，不是完整 `Location.Ref`，也不是用户 Shell 的当前 `$PWD`。v1 不接受相对路径、`~`、环境变量或 shell 表达式展开。路径使用目标平台语义校验。

### 1.2 默认值

先解析目标 identity，再应用下表。`agent.location` 指调用父 Session 的持久 Location directory。

| target 参数     | location 参数 | 最终 target   | 最终 directory                 |
| --------------- | ------------- | ------------- | ------------------------------ |
| 省略            | 省略          | parent.target | parent.directory               |
| 省略            | 显式绝对路径  | parent.target | 显式路径                       |
| 与 parent 相同  | 省略          | parent.target | parent.directory               |
| 与 parent 不同  | 省略          | 指定 target   | 该 target 的实际 homeDirectory |
| 任意有效 target | 显式绝对路径  | 指定 target   | 显式路径                       |

相等比较基于解析后的 target identity，不比较用户输入字符串。显式空字符串是错误，不视为省略。

`homeDirectory` 是 local 用户或远端连接用户的实际 HOME，由对应 provider 的既有环境探测解析。它与 target registry 的 `defaultDirectory` 不同：后者继续服务于 QuickStart 初始目录建议，不用于本默认值。HOME 无法确定、不可访问或位于 negotiated roots 外时失败，不回退到 `/`、defaultDirectory、父目录或本机 HOME。显式传入 location 时无需为了该默认值再探测 HOME。

不为此新增可编辑的 homeDirectory 配置或把 HOME 当作永久健康事实。target list 不需要额外连接来查询它。同 target 同 directory 保留既有 workspace identity；改变 target 或 directory 时不能复制父 workspaceID 来宣称同一 placement，v1 使用无显式 workspaceID 的 Location，并由目的地发现项目根。

### 1.3 校验与创建顺序

```text
检查调用者 Task 权限、subagent access 和深度
  -> 固定 target identity，计算 directory
  -> prepare target / Location services
  -> 校验连接、能力、roots、canonical path、目录存在和可访问性
  -> 在目的 Location 解析 child definition、权限、环境与初始 context
  -> 重新确认 target 配置与有效访问策略未失效
  -> 创建持久化显式 Location 的 child Session
  -> 接纳 child prompt 并按 child Session ID 执行
```

校验不得调用 `mkdir`、目录创建向导或“目录不存在则创建”的 QuickStart workflow。不存在、非目录、损坏/循环 symlink、越界、无权限、未知 target、连接失败均在创建 child 之前返回明确错误；父 Task 的失败记录可以存在。symlink 保留可用逻辑路径，使用 target canonical path 校验真实包含关系。

目的目录在校验后被外部删除属于正常竞争：后续访问失败，不补建目录、不重选位置。每次 filesystem operation 仍遵守 provider 的 roots 校验。本保证针对目的地解析/校验/创建流程；成功启动后的 child 仍可在任务与权限允许时显式创建文件或目录。RFC-0002 管理的 Rexd 安装目录与已有内部运行数据保持原契约，不能借此创建缺失的实验目录。

preflight 失败不得产生可运行的 child；创建成功后的 provider/模型失败保留真实 child identity 和失败状态，不伪装成创建失败后另建 child。重试继续使用既有 invocation/idempotency 契约，不引入第二套 executor。

### 1.4 子环境、权限与结果

必须从 child Location 构造 filesystem/process、工具 registry、环境 snapshot、target platform、项目根、项目 AGENTS.md/instructions、Skill scope 与 context epoch。控制设备全局规则按 RFC-0011 保留；父项目规则和父 `.env` 不因亲子关系复制到目的地。父提供的 task prompt 是任务内容，不能成为目的地环境事实。

subagent 先通过父 effective catalog（RFC-0016）授权，再在目的地验证同一 definition identity 可用；不能因同名改用另一个项目 Agent。目的地缺少所选定义时显式失败。最终权限保留父链 hard deny、所选 definition 和目的 Location 限制；路径权限不得把父机器上的同名路径许可直接移植到另一机器。

Task 的返回值和可见 metadata 至少记录 child Session ID、实际 target ID/名称和 directory。TUI 的 Task 卡片及 child Session 页面能看见实际位置。文件路径与结果归属于该 child Location；父 Agent 不应把远端路径当成本机路径。输出不包含连接配置、凭据或环境变量值。

### 1.5 Resume 与嵌套委派

提供 `task_id` 时先解析已有 child；省略 target/location 使用该 child 已存储的位置，不重新应用新建默认值。显式参数只允许与原位置一致；冲突返回 `task_location_mismatch`，不迁移、不新建、不向旧 child 投递 prompt。未知或不可访问 task_id 必须失败，不能退化为新建。每次 resume 继续检查调用者的现行访问权。

若现有深度与 Task 权限允许嵌套委派，child 仍可使用 Task 参数为自己的 child 选址；默认值相对于实际调用 Session。禁止 subagent 使用 slash 工具与是否允许其使用 Task 是独立规则。RFC-0015 的控制操作按 child Session ID 和实际 Location 路由，不假设 parent/child 同位置。

## 二、Target description 与文本列表

Target Input/Definition 增加可选 `description: string`。旧配置缺失等价于空描述，不因读取而重写。创建/编辑向导提供描述字段，管理列表和详情可查看与编辑，Core CRUD/JSONC 持久化保留 revision 冲突处理。描述是设备本地用户维护的用途信息，不是命令或授权，不进入 target identity，也不通过 Session sync 复制 registry。

`/target list` 是独立的只读叶子命令，允许 `[User, Agent]`。输出使用固定文本表格或逐行记录，包含可用于 Task 的 selector、显示名称、description，以及已有缓存状态（有则附时间，否则 unknown）。包含 local；local 行使用固定说明，本 RFC 不新增 local registry entry。

```text
selector       name          description                   status
local          local         Local execution target        available
<target-id>    gpu-lab       GPU experiments and evaluation unknown
```

“已配置、可选择”和“当前在线”必须区分。该命令只读 registry/既有健康缓存，不主动探测全部 target，不安装 daemon，不读取远端目录或启动 shell。真正创建时必须重新校验。配置损坏产生明确诊断，不能显示成功的空列表；诊断不泄露连接信息。

User/Agent 共享相同脱敏数据与 renderer，不输出 SSH host/user/port、key path、daemon command、配置文件路径或原始 registry。用户主动填写的 description 可见，字段提示应说明这一点；renderer 对换行/终端控制字符做安全处理，采用有界长度，避免将描述解释成指令或终端控制序列。

`/target` 的交互管理器及 add/edit/remove 等操作保持 User-only；开放 list 不意味着开放整个命令组。

## 三、Slash command 的受众与执行契约

### 3.1 注册与配置

在 RFC-0003 的叶子 command metadata 上增加 `audiences: (User | Agent)[]`，缺失默认 `[User]`。允许配置 `[User]`、`[Agent]`、`[User, Agent]` 或 `[]`。配置以稳定 command ID 为键，alias/path 不拥有独立权限；User 和 Agent 的可访问性互不推导。

Agent 执行资格还要求经过适配的 headless text handler。用户可以对支持该能力的命令选择受众，但不能通过将 UI-only、legacy-opaque 或 prompt-only command 标成 Agent 就让它获得新执行能力。项目内容、Skill 和模型输入不能自行更改设备级受众授权。原有 disabled、capability deny、readOnly 和 domain permission 继续叠加生效。

执行时先按既有冲突/alias/longest-match 规则解析 winner，再对 winner 做受众和 headless 能力校验。不因 winner 对 Agent 不可用而回退到被 shadow 的另一实现。发现、help 和执行使用同一有效视图，防止手输或 alias 绕过。

### 3.2 独立工具与无 UI 保证

```text
slash_command({ command: "/target list" })
slash_command({ command: "/slash help target list" })
```

输入是单条 slash command 文本，按 command parser 处理；没有 shell interpolation、管道、重定向或命令串执行。`bash` 与 User Shell 不自动识别该工具语法；不复用 `session.command` 的 prompt-template 执行语义。

执行主体由可信 invocation Session/agent runtime 推导，模型不能传 `actor: User`。工具仅提供给顶层主 Session；任何 `parentID` 非空的子 Session 均从工具目录中移除，并在执行边界再次拒绝，包括切换为 primary/all Agent、alias、恢复旧调用或其他工具间接转发。子 Session 即使被用户打开也不会因此获得该模型工具；用户本人仍可使用 User 入口。

Agent handler 的上下文不提供 dialog、picker、导航、editor 或确认 callback。必须在产生业务副作用前确认全部必需输入与非交互前置条件；需要补参数、确认或其他 UI 时返回 `interaction_required`/`invalid_arguments`，不能打开面板、等待点击或自动代答。若工具/domain 的现有策略要求尚未满足的人工批准，该渠道返回明确拒绝，Agent 可用普通对话说明；不因本工具调用弹出审批交互。

首批 Agent 实际可执行集合只有 `/target list` 与 `/slash help`。没有 headless adapter 的现有命令保持 User 行为；prompt command、MCP prompt、Skill slash、UI callback 不被自动桥接为 Agent command。未来新增 Agent 命令逐个注册、测试其非交互契约。

### 3.3 文本结果、错误与展示

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

### 3.4 帮助注册

每个 command 可注册纯数据 help：usage、参数、默认值、示例、受众和效果说明。统一入口：

```text
/slash help
/slash help target list
/slash help slash help
```

无参数打印当前调用者可访问的命令及简要帮助；带路径打印对应 winner 的完整帮助。仅 User 可用的 UI command 也可注册帮助，User 可以打印；Agent 的 help 只列出对 Agent 可执行的命令，查询其他命令返回不可用。帮助的读取不执行被查询 command，不调用模型、不加载远程 MCP prompt、不运行 Skill 或 plugin callback。

未适配的旧 command 使用已知 metadata 提供最小帮助，并明确标识详细帮助不可用，不猜测参数与效果。group 与叶子可分别注册帮助；同一解析规则处理 alias 和冲突。`/slash help` 自身具有 help 且默认允许 `[User, Agent]`。

## 四、普通 Skill 与上下文职责

提供一个可由用户按普通方式安装的 Skill 文本，介绍 slash 工具、`/slash help`、`/target list`、Task 的 target/location 默认值与错误处理。它不是内置 Skill，不自动安装、不修改默认系统 prompt，也不硬编码用户 target 或路径。Skill 按 RFC-0012 的已有发现/加载机制工作；本 RFC 草案不安装该 Skill。

Skill 教 Agent 先查帮助和 target 描述。目的目录由用户要求或其他已有上下文提供，省略时按默认值解析。框架不新增远端 ls、目录补全、跨 target bash 或其他目录探索工具；target 描述也不触发这些动作。Skill 内容和 target description 都不能授予执行权限。

## 五、分层、兼容与 RFC 关系

command-kit 保持 runtime-neutral，拥有 audience/help/parser/result 的公共内部契约。Core 拥有 actor 校验和 headless command dispatch；target list 消费 TargetRegistry 的脱敏 projection。Server 必要时只提供类型化 adapter，TUI 负责输入和展示；不能把 TUI callback 搬到服务端模拟点击。

Task 负责解析目的地并调用显式 Location 的 Session 创建 workflow；Location providers 和既有 context services 负责远端验证与初始上下文。SessionExecution 继续是 process-global、Session-ID based，SessionRunner/工具/权限继续 Location-scoped。不能从 parent 捕获的服务容器解析 child prompt 文件引用或执行 child 工具。

| RFC       | 本提案的增量                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| 0002      | 允许新 child 与 parent 不同 Location；每个 Session 内仍只有一个执行位置                            |
| 0003      | 增加 actor audience、注册帮助和受限 headless execution plane；保留 User resolver 与兼容来源行为    |
| 0009      | 无修改；不以 Task 或 slash 工具实现 rebind                                                         |
| 0010      | child 使用自身既有 portable Location 同步；不新增 registry/description/连接信息同步                |
| 0011/0012 | 在 child 目的地生成独立环境、规则与 Skill 上下文                                                   |
| 0016      | 父 effective catalog 决定可选 definition；其 Location 限制不再等同于强制同位置，但实际权限仍需验证 |

RFC-0015（[设计 PR #437](https://github.com/hammershock/opencode-transit/pull/437)）仍为独立草案。本 RFC 的创建与 resume 不依赖它先接受；未来 status/wait/send/interrupt 必须读取 child 自身 Location，不能从父位置推断。

旧 Task 省略参数保持既有同位置行为；新建输入的新增字段可选。无 description 的 registry 继续可读；旧 command 默认 User-only。新增公共 Protocol/HttpApi 必须运行 `packages/client` 的 `bun run generate`；不得手写生成代码或改变 legacy `session.command` 的语义。未支持新参数的运行路径应明确拒绝，不能悄悄忽略 target/location。

## 六、实现任务边界

接受后按以下四个可独立评审的任务建立实现 issue；本设计 issue 不代表实现 Ready：

1. **Target description**：schema/registry、创建编辑查看、兼容旧配置和脱敏 list projection；不修改 Task 或授予 Agent 命令访问。
2. **Headless slash channel**：audiences、help、主 Session 工具、非交互执行/拒绝、TUI 卡片、`/target list` 消费者及普通 Skill 示例。依赖任务 1；一个完整的可见竖切。
3. **Task destination**：参数/defaults、target/HOME 解析、无 mkdir 验证、child 创建/context/权限、resume 与实际位置展示。独立于任务 2，可用用户已提供的 target identity 验收。
4. **Integrated acceptance**：在上述功能具备后，以普通 Skill 发现命令，在 Mac 父 Session 中创建 Linux Rexd child，验证目的地规则/环境、失败路径和工具不可用性。该项可作为末个实现 issue 的验收部分，无需为测试机械拆 PR。

每个实现 issue 必须按开发工作流补齐明确依赖、Ready 条件、分支/worktree/PR 和生成物预期。共享 Task identity/cancellation 与 #432/#433 的后续工作协调，避免另造 invocation 或通知系统。

## 七、验收与验证

1. 默认值表每行、显示名解析为相同 ID、空参数和远端到 local 均有 contract test；HOME 与 defaultDirectory 故意不同时使用 HOME。
2. Missing、非目录、无权限、symlink 越界、HOME unknown、target offline 均不创建 child、不调用目录创建、不回退 local。
3. 显式路径成功时无需 HOME；根目录限制在后续文件操作仍有效；外部删除目录不触发补建。
4. child 的文件、shell、项目根、平台、规则、环境与 Skill 均来自目的地；父同名路径、规则和 `.env` 不泄漏。验证无显式 workspaceID 路径及定义缺失错误。
5. Task 返回真实位置；resume 省略参数保持原 child，冲突/未知 ID 不生成新 child；取消/重试不重复创建。
6. description 在创建、编辑、查看、list 一致，旧配置不被读取重写；list 无 SSH/目录调用与敏感字段。
7. audience 的四种组合、alias/shadow、disabled/readOnly/capability deny 均通过相同 resolver 生效；手输不可绕过。
8. subagent 无工具定义且直接调用被拒绝；切换 Agent mode、恢复、间接调用都不扩大权限。
9. headless handler 无 UI 服务；缺参数/确认返回文本错误且无副作用；未适配 prompt/UI command 不被执行。
10. help 使用注册 metadata，读取帮助不执行命令；User 和 Agent 各自可见集合正确，旧命令有诚实 fallback。
11. Agent 卡片具有 bash 风格的状态与纯文本输出，不触碰用户输入焦点；User 交互命令仍正常。
12. 普通 Skill 安装后能够指导完整流程；未安装时底层契约仍可用，不依赖 Skill 进行权限校验。

文档阶段只检查格式、链接、示例和边界一致性。实现阶段涉及权限、远端执行和 Session context，不能仅按低风险 fast path 验收：需 command-kit/Core/Task 的针对性 contract 与临时数据库/filesystem integration tests、受影响包内 `bun typecheck`、所需 client generation，以及精确提交的 clean Mac build。

真实场景至少为 Mac 主 Session → Linux Rexd child，在两个位置放置不同的 AGENTS.md、非敏感环境标记与同名测试文件；验证 child 只见目的地内容，父仍在原处。再验证另一已有目录、跨 target 默认 HOME、缺失目录、断连和 child slash 拒绝。UI 提供卡片及 target description 创建/编辑截图。若修改 Windows 路径、HOME 或 transport 行为，增加该平台证据；未测平台不能声称通过。

同步 projection 使用既有契约做回归；若实现改变 portable Location 或亲子同步语义，则升级为实际双设备验收。测试只使用隔离 Session、配置与显式测试目录，不改动用户真实实验环境。

## 八、供评审确认的细节

下列是本草案为使实现可判断而选择的细化，可在接受前调整：

- `target` 的 canonical selector 为 ID/`local`，唯一精确名称作为便利输入；`location` 仅接受绝对目录。
- 跨 target 默认 HOME 使用 provider 实际探测，与 QuickStart defaultDirectory 分离。
- `/slash help [command path]` 为集中帮助入口；Agent 帮助只列出自身可执行项。
- 需要 UI 或人工批准的 Agent command 直接返回 interaction-required/denied；不自动批准、不打开审批界面。
- `/target list` 只展示 registry 与已有缓存状态；连接和目录验证延迟到 Task 创建。
- subagent 禁用 slash 工具，但已有 Task 深度允许时仍可带目的地参数进行嵌套委派。

---
id: 0016
title: Subagent Access and Definition Manager
status: accepted
authors:
  - hammershock
created: 2026-09-18
updated: 2026-09-18
implemented-by: []
depends-on:
  - 0011
  - 0014
supersedes: []
superseded-by: []
---

# RFC-0016：Subagent 访问与定义管理

## 摘要

OpenCode Transit 提供一个 `/subagent` 主面板，用于查看全部可委派 Agent、编辑全局 subagent 定义，以及设置**当前父 Agent**对每个 subagent 的访问状态。定义的增删改始终写入控制设备的全局 OpenCode 配置；访问状态只有两层：按父 Agent 持久保存的全局默认值，以及当前 Session 的显式覆盖。没有配置时默认 active。

面板中的实心或空心圆点始终表示当前父 Agent 在当前 Session 的真实有效状态，不表示配置来源。Session 覆盖优先于全局默认；全局操作同时更新默认值并清除当前 Session 对应覆盖，使当前 Session 立即继承新默认。不同父 Agent，例如 `build`、`plan` 和自定义 primary Agent，可以拥有不同的 subagent 集合。

模型、Task 参数、Task 执行、RFC-0014 economics 和 TUI 必须消费同一个有效目录。配置为 inactive、当前父 Agent 不可调用或已失效的 subagent 不进入模型目录，也不能通过手写名称或旧 alias 绕过。模型只收到一行、受预算限制的名称、用途与能力摘要，不接收原始权限规则。

本 RFC 记录 issue [#456](https://github.com/hammershock/opencode-transit/issues/456) 中已经确认的产品契约。RFC-0015 管理已经委派的子 Session 的状态、等待、中断和接续；本 RFC 只管理哪些 subagent 可以被选择以及定义本身。

## 目标

1. `/subagent` 成为唯一的 TUI subagent 定义与访问管理入口。
2. 用户始终看到当前 Session 的有效状态，而不是某一层原始配置。
3. 不同父 Agent 分别拥有全局默认集合，并能在单个 Session 中覆盖。
4. 所有 subagent 默认可访问；只有显式配置才收紧集合。
5. 定义支持全局新增、编辑和删除，包括名称、模型、描述、指令、步骤和能力权限。
6. 模型获得足够选择 subagent 的能力信息，同时保持上下文短小稳定。
7. 展示、参数验证和执行授权不再使用各自不同的过滤逻辑。
8. 兼容现有 Agent Markdown、`agent` 配置与 `permission.task` 规则，不要求用户手工迁移。

非目标：管理正在运行的子 Session；自动挑选 subagent；workspace 级访问覆盖；同步全局 Agent 配置；为 Web/Desktop 提供完整 manager；引入新的权限动作；把完整 prompt、路径 glob 或原始配置注入模型；允许 subagent 绕过父 Session 的 Location 或安全限制。

## 一、概念模型

### 1.1 Definition 与 Access 分离

系统明确区分两个问题：

| 概念                    | 回答的问题                               | 作用域                         |
| ----------------------- | ---------------------------------------- | ------------------------------ |
| Subagent Definition     | 它是谁、用什么模型、被调用后能做什么     | 控制设备全局                   |
| Parent Access           | 当前父 Agent 能否选择和调用这个 subagent | 全局默认或当前 Session 覆盖    |
| Effective Catalog Entry | 当前 Session 中最终是否可用及其摘要      | 由 resolver 计算，不单独持久化 |

Definition 的能力权限不决定哪个父 Agent 能发现它。Parent Access 不扩大 Definition、父 Session 或 Location 已有的执行权限。

### 1.2 稳定身份

名称可以编辑，因此访问策略和 Task 调用不得以显示名称作为身份。每个可委派 Agent 具有稳定 `AgentID`：

```text
AgentIdentity {
  id          // 稳定、不可编辑；短 slug 或 agt_ opaque ID
  name        // 可编辑显示名称
  aliases[]   // 只用于兼容解析，不授予访问权
  source      // builtin | global | project | compatibility
}
```

- built-in 使用固定 ID，例如 `general`、`explore`；
- manager 新建的定义从初始名称生成可读 slug，冲突时追加短随机后缀；后续改名不改变 ID；
- 既有全局 Agent 在第一次被 manager 修改时写入稳定 ID；此前由 source kind 与全局相对路径或配置 key 确定性派生；
- project 或其他兼容来源不写入全局文件，identity 由来源与相对 key 派生；外部移动在尚未 materialize ID 时可以形成新 identity；
- alias 只解析尚未迁移的旧 Task/session 引用。存在歧义时必须失败并列出非敏感候选，不能按加载顺序选择。

Task 的 canonical 参数传递 `AgentID`。兼容字段 `subagent_type` 可以暂时接收唯一旧名称，但解析后必须立即固定为 ID；新生成的 schema 和模型目录只发布 ID。执行结果继续显示名称，并携带 ID 供机器关联。

### 1.3 候选集合

候选集合包含当前 registry 中 `mode: subagent` 或 `mode: all` 的 Agent。`primary`、内部 maintenance Agent 和无法由 Task 启动的定义不出现。`hidden` 仍是旧 autocomplete 表现，不再充当授权规则；只要定义可委派，它必须出现在人类 manager 中，是否进入模型目录由有效访问状态决定。

全局与 built-in 定义可由 manager 修改。project/compatibility-only 定义仍显示并可设置 Parent Access，但定义字段只读，并以短 source 标签说明原因；本面板不能把 project 文件静默改写成全局配置。用户可以通过 Add 创建新的全局定义，或在未来显式提供“Copy to global”，后者不属于 v1。

## 二、访问状态

### 2.1 两层配置

访问策略以 `(parentAgentID, subagentID)` 为键：

```text
GlobalDefault: active | inactive | absent
SessionOverride: active | inactive | absent
```

解析顺序为：

```text
Session active/inactive
  > Global active/inactive
  > default active
```

`absent` 表示继承，不是第三种用户可见状态。Global 是当前控制设备上所有 Session 的默认值，不进入 Session sync；Session override 属于 Session durable state，随 Session 的既有持久化、fork 和 sync 语义传递。另一设备缺少同一 `AgentID` 时保留覆盖但目录不产生条目，不能按同名 Agent 猜测绑定。

当前父 Agent 来自 TUI 当前选择和下一 provider turn 的实际 Agent identity。切换 `build`、`plan` 或自定义 Agent 后，面板立即对新的 parent key 重新解析。

### 2.2 操作语义

正常列表只显示最终状态：

```text
● active
○ inactive
```

Space 对选中条目执行 activate/deactivate，并弹出仅含两个选项的 scope chooser：

- **This session**：写入当前 `(Session, parent, child)` 的 active 或 inactive 覆盖；
- **Globally**：写入 `(parent, child)` 的全局默认值，同时删除当前 Session 的对应覆盖，使当前 Session 立即继承这个新默认。

Global workflow 必须以一个有 revision 的领域操作提交两个 mutation。实现可以使用短 journal 和恢复，也可以使用同一事务存储；对调用方只允许全部成功或明确失败。失败后刷新真实状态，不能留下圆点与持久化状态不同步的乐观结果。

Session 操作只影响当前 parent。`build → reviewer` 的设置不改变 `plan → reviewer`。Add/Edit/Delete Definition 不隐式改变任何其他 parent 的访问策略；新定义因默认规则立即对所有 parent active。

### 2.3 与现有 Task permission 的关系

现有 `agent.permission.task` 同时承担 Task 工具开关与按名称筛选，概念混杂。迁移后：

- `task: deny` 或等价 wildcard deny 继续表示父 Agent 整体不能使用 Task，是 resolver 的上限；面板中所有条目呈 inactive，且不能通过局部 activate 绕过；
- 精确的 child allow/deny 规则兼容映射为该 parent 的 Global Default；manager 第一次保存时以稳定 ID materialize；
- 精确 `ask` 兼容为 active 且 `approval-required`。用户从 manager 选择 Activate 后 materialize 为 active/allow；
- 新的 per-child 设置不再写入模糊名称 pattern；
- Session 中旧的精确 child rule 同样映射为 Session override；无法唯一解析的 pattern 保留原权限行为并产生有界 diagnostic，不静默绑定。

父 Session 的其他 hard deny、Location 限制以及 child Definition 自身 deny 继续生效。它们不成为第三层 Parent Access。若 Task 工具整体不可用，resolver 返回明确的 parent-level disabled reason，圆点和模型目录都据此更新。

## 三、有效目录

### 3.1 单一 resolver

Core 提供一个 provider-neutral resolver，输入至少包括：

```text
ResolveSubagents {
  sessionID
  parentAgentID
  location
  registryRevision
  globalAccessRevision
  sessionAccessRevision
}
```

输出为稳定排序、带 revision 的 snapshot：

```text
SubagentCatalogSnapshot {
  revision
  parentAgentID
  sessionID
  entries[] {
    id
    name
    description?
    model?
    effective: active | inactive
    reason?: parent-disabled | global | session | unavailable
    capabilitySummary
    editable
    source
  }
  diagnostics[]
}
```

以下消费者必须使用该 snapshot 或相同 revision 下的 resolver，禁止各自重新实现 filter：

1. `/subagent` 人类列表，包含 active 与 inactive；
2. Task 工具描述与参数 schema，只包含 active；
3. Task 执行解析与授权，只接受当前 snapshot 中 active 的 ID；
4. RFC-0014 `<available_subagents>` economics，只包含同一 active 集合中的 model-bound 项；
5. 未来的 picker、API 和 context inspector。

Task 执行同时验证 snapshot revision。正常静态配置下，模型看到的每个 ID 都可以发起调用。若用户或外部编辑器在同一个 provider turn 中改变 revision，执行返回明确的 `catalog_changed` 并触发下一安全边界重新生成目录；它不是 unknown-agent 或权限拒绝，也不会启动 child。测试必须覆盖此并发边界。

旧 alias、inactive ID、primary-only ID 和从未出现在 snapshot 的任意字符串在执行层统一拒绝。参数 schema 使用 active ID enum 或等价严格验证，不能继续使用无约束 string 作为唯一防线。

### 3.2 面向模型的最小摘要

模型不接收 raw `PermissionV1.Ruleset`、filesystem path、source path、config revision 或 inactive 条目。每个 active 条目最多一行：

```text
<subagent id="reviewer" name="Reviewer" capabilities="workspace-write,shell-approval,no-delegation">Review changes and run focused checks.</subagent>
```

固定 renderer：

- 对 ID、name 和 description 做转义；
- description 规范为空白并按 UTF-8 byte budget 截断；
- capability 使用稳定枚举和固定顺序；
- 每项最多 240 bytes，完整目录默认最多 8 KiB；超限按稳定 ID 顺序截断并标注；
- Task description 不复制 economics 的 model/price/benchmark；economics block 不复制用途和权限长文；
- 完整 prompt/instructions 永不进入目录。

能力摘要从 child 的**有效执行权限**保守推导：

| 标签              | 含义                                                      |
| ----------------- | --------------------------------------------------------- |
| `read-only`       | 常规读取/搜索可用，workspace mutation 与 shell 不可用     |
| `workspace-write` | 可以修改当前 Location workspace                           |
| `full-access`     | 常规工具集合允许；仍受 Session、Location 和父链 hard deny |
| `shell`           | shell 允许                                                |
| `shell-approval`  | shell 需要人类批准                                        |
| `web`             | web fetch/search 至少一项可用                             |
| `delegation`      | child 可以继续 Task 委派，仍受深度限制                    |
| `no-delegation`   | child 不能继续 Task 委派                                  |
| `restricted`      | 存在无法被上述标签无损表达的 custom rule                  |

`full-access` 不是 sandbox 或安全保证。无法准确判断时必须选择较弱标签并加 `restricted`，不能夸大能力。

## 四、全局 Definition 管理

### 4.1 字段与权限 profile

v1 editor 支持：

- Name；
- Model 与 variant；
- Description；
- Instructions/prompt；
- Step limit；
- Capability profile；
- Custom permission rules 的兼容保留。

Capability profile 提供三个短选项并展开为已有 `allow | ask | deny` rules：

| Profile     | 默认行为                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| Read only   | 允许 read/search/web；拒绝 edit、workspace shell mutation 与 delegation     |
| Write       | 允许 workspace read/write；shell 需要批准；默认拒绝 delegation              |
| Full access | 允许常规执行工具；继续受父 Session、Location、external-directory 与深度限制 |

现有规则不精确匹配 profile 时显示 `Custom`。选择任一 profile 会以明确预览替换 custom rules；用户取消不写入。v1 不在主列表铺开 permission matrix。Custom editor 只在编辑区按需展开核心工具行，未知 rule 原样保留，除非用户明确选择 profile 覆盖。

### 4.2 持久化与 mutation

manager 通过 typed Core/Server workflow 修改控制设备 Global config，TUI 不直接写文件。Global Agent 文件继续使用既有 Markdown/frontmatter，以便 CLI 和用户编辑器兼容；manager-owned definition 写入稳定 ID 和 schema revision，并采用同目录临时文件、fsync/flush 与 atomic replace。所有 mutation 接收 `expectedRevision`，外部编辑导致冲突时拒绝保存并重载。

- Add 创建 manager-owned global Agent definition；
- Edit 原位修改同一稳定 ID，不因改名移动 identity；
- Delete custom global definition 时先移动到 OpenCode managed trash，再从 registry 发布删除；
- Delete built-in definition 写入 global disabled overlay，不删除程序文件；
- 恢复入口不属于 v1，但 managed trash 不得与活跃 discovery path 重叠；
- project/compatibility-only definition 不提供 Edit/Delete；
- mutation 成功后使 registry/catalog 失效，并影响下一 provider turn；已经运行的 child Session 不被终止。

Definition 删除后，Global/Session access 中引用该 ID 的条目可以保留为 orphaned policy，以便恢复同一 ID 后复用；正常面板不显示孤儿项，diagnostics 只给出计数。任何同名新 Agent 都不得继承旧 ID 的策略。

## 五、TUI 契约

### 5.1 单面板

`/subagent` 打开一个可调整宽度的 dialog，标题显示当前 parent，例如：

```text
Subagents · build

● Explore       openai/gpt-5.6-luna   Read only    Search and inspect the codebase
● General       openai/gpt-6-astra    Full access Execute multi-step implementation tasks
○ Deploy        anthropic/claude-...  Custom       Publish an approved release
```

每行固定为：状态、Name、Model、Capability、Description。默认不显示 ID、source path、revision、原始 permission 和配置层级。只有发生重名、只读来源、诊断或截断时增加一个短标签。

dialog 优先使用终端可用宽度，保留最小外边距；列保持单行，不自动把一个条目展开成多段说明。仍无法容纳时启用横向滚动，Left/Right 移动 viewport，并只在存在 overflow 时显示一次短提示。垂直滚动保持选中行可见。

### 5.2 输入与编辑

正常态保留最少操作：

- Up/Down：选择；
- Space：activate/deactivate，随后选择 This session 或 Globally；
- Enter：在同一 dialog 内打开选中 definition 的编辑区；
- `a`：在同一编辑区创建 definition；
- `d`：删除可编辑 definition；
- Escape：关闭或取消当前 draft。

footer 只显示当前状态适用的按键。鼠标点击行只选择，双击等同 Enter；不增加一排常驻按钮。

编辑区属于同一个 dialog，不打开新的全屏 route。宽终端采用列表加右侧 form；空间不足时 form 覆盖列表内容但保留同一标题和返回位置。字段按 Name、Model、Description、Instructions、Steps、Capability 排列。Model 使用现有 model selector；Description 保持短输入，Instructions 允许受边界的多行编辑。`Ctrl+S` 保存，Escape 丢弃 draft 并回到原选中行。

删除是唯一需要确认的 destructive 操作。确认在当前 dialog 内显示 definition 名称与 `Delete`/`Cancel`，不展示配置路径。built-in 文案使用 Disable，custom global 使用 Delete。Activate/Deactivate 不二次确认，只选择作用域。

保存期间禁止重复提交并保留 selection。成功后就地刷新，不关闭 manager；失败显示短 toast 并重读服务器事实。面板不得用乐观圆点掩盖失败。

### 5.3 与现有入口的关系

- `/agents` 继续负责切换可作为 primary 的 Agent；
- `/subagent` 负责 subagent 定义与当前 parent 的访问；
- `/context` 继续检查实际进入模型的目录/economics renderer；
- active child Session 的 status/interrupt/wait 属于 RFC-0015，不塞入本面板。

## 六、API、应用与恢复

Server 暴露类型化 workflows，而不是让客户端组合 config 和 Session patch：

```text
subagent.catalog(sessionID, parentAgentID, includeInactive)
subagent.definition.create(expectedRevision, draft)
subagent.definition.update(id, expectedRevision, patch)
subagent.definition.delete(id, expectedRevision)
subagent.access.setSession(sessionID, parentID, childID, active)
subagent.access.setGlobal(sessionID, parentID, childID, active, expectedRevision)
```

Global access workflow 接受 Session ID 是为了原子清除当前 override，不赋予修改任意 Session 的权限。Instance/Session 路由、调用者 authority 和 Location ownership继续使用现有 middleware。Public Protocol/HttpApi 变更必须从 `packages/client` 运行生成器，不能手改 generated clients。

外部配置编辑、另一个进程或同步 Session 更新可能造成 revision 冲突。所有 mutation 返回最新 revision 或 typed conflict。启动恢复发现未完成 global journal 时，在发布 catalog 前完成或回滚；无法恢复时保持旧 snapshot、禁止相关写入并显示一条 bounded diagnostic，不能猜测半完成结果。

当前 Session 的 override 在 fork 时随 Session facts 复制；新 Session 没有 override，使用 global default。删除 Session 自动删除覆盖。Global defaults 与 definitions 不进入 RFC-0010 Session sync，也不从另一设备自动下载。

## 七、兼容与迁移

1. 既有 built-in、global Markdown、JSON config 和 project Agent 继续被发现。
2. 未经 manager 修改的文件不因启动而重写。
3. 旧 name-based `permission.task` 按唯一 identity 兼容解析；首次相关 mutation 才 materialize stable ID policy。
4. 旧 Task transcript 和 `task_id` 继续可读；恢复新的 invocation 时重新检查当前 effective catalog。
5. `/agents`、CLI `agent create` 和插件定义继续工作；新增定义下一次 registry reload 后进入 manager。
6. RFC-0014 economics 改用本 RFC snapshot；实验开关关闭时仍不注入 economics，但基础名称/用途/能力目录始终由 Task 使用。
7. 未升级客户端仍可使用现有 config endpoint；它不会获得 manager 的原子 global+Session workflow保证。

迁移不得把 `hidden` 当成 deny，也不得因为同名而合并两个 stable identity。解析失败只使受影响条目 unavailable，并保留其他目录。

## 八、实现任务

接受后至少拆为两个顺序任务：

1. **Foundation**：stable identity、global definition/access storage、Session override、resolver、legacy migration、Task/schema/execution/economics 统一与 typed API；
2. **TUI vertical**：`/subagent` 单面板、scope chooser、inline editor、permission profiles、宽度/横向滚动、错误恢复和截图验收。

Foundation 必须先合并。TUI 不能先用本地状态或直接 config write 模拟未完成的 Core workflow。

## 九、验收条件

1. 新安装中全部可委派 subagent 对全部父 Agent 默认 active。
2. `build`、`plan` 和自定义父 Agent 的全局默认互不影响。
3. Session override 胜过 global；删除 override 后立即继承 global。
4. Global activate/deactivate 更新默认并清除当前 Session override，成功或失败均不出现部分状态。
5. 圆点、Task 目录、参数 schema、执行校验和 economics 对同一 revision 得到相同 active 集合。
6. inactive、旧 alias 歧义、primary-only 和手写未知 ID 均不能启动 child。
7. 模型目录每项一行、完整内容受 8 KiB 上限约束，包含保守能力摘要且没有 raw rule/path。
8. 改名不改变 stable ID、access policy 或已有结构化引用；同名不同 ID 不合并。
9. Add/Edit/Delete 只修改全局定义；project/compatibility definitions 保持只读。
10. capability profile 正确展开；Custom 未被选择替换时未知 permission rule 不丢失。
11. `/subagent` 在宽终端维持单行列；窄终端可横向滚动；编辑、scope chooser 和删除确认都留在一个 dialog。
12. 外部编辑冲突、global workflow 中断、orphaned policy、缺失 model 和 registry reload 均有失败路径测试。
13. 已运行 child 不因 definition/access 改动被取消；下一次委派使用新 snapshot。

## 十、验证与风险

Foundation 涉及持久配置、Session 数据、授权与 public API，不能使用 focused fast path。至少需要：

- Core resolver、identity、migration、revision 和 journal 单元/集成测试；
- Task description/schema/execution 与 economics 集合一致性 contract tests；
- 临时 Global config 和临时数据库上的 definition CRUD、trash、Session fork/sync projection 测试；
- `packages/core`、`packages/opencode`、`packages/client` package-local typecheck 与所需 client generation；
- 精确 PR head 的 clean Mac build。

TUI task 至少需要 manager reducer/interaction tests、窄/宽 terminal snapshot、失败恢复测试、package-local typecheck、截图或录屏，以及 Mac `opencode-transit` 实际工作流：分别以 `build` 和 `plan` 设置 Session/global 状态，新增、改名、换模型、切 capability、删除隔离测试 Agent，并验证模型目录与 Task 执行一致。该行为平台中立；若没有修改 Windows path、filesystem atomic primitive 或 packaging，WSL2 为可选且不能被声称通过。

测试只能使用隔离的临时 Global config 和 Session。不得改动或删除用户真实 Agent 定义、provider credential 或生产 Session；真实验收创建带唯一前缀的定义并在完成后通过产品 workflow 移入 managed trash。

主要风险是重命名造成策略漂移、两处 mutation 部分成功、兼容 pattern 误绑定、模型目录过长，以及 UI 显示与执行授权分叉。本 RFC 通过 stable ID、revision/journal、唯一解析、固定预算与单一 resolver 约束这些风险。任何扩大到 workspace policy、跨设备同步、自动路由或 raw permission context 的变化都需要 RFC 修订。

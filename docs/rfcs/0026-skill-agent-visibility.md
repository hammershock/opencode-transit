---
id: 0026
title: Agent-scoped Skill Visibility
status: accepted
authors:
  - hammershock
created: 2026-09-28
updated: 2026-09-28
depends-on:
  - 0012
  - 0016
supersedes: []
superseded-by: []
---

# RFC-0026：按 Agent 配置 Skill 可见性

## 状态与动机

本文是 issue [#706](https://github.com/hammershock/opencode-transit/issues/706) 的已接受设计，实现由 issue [#708](https://github.com/hammershock/opencode-transit/issues/708) 跟踪。维护者接受时明确要求 `/skills` 仅展示 Agent 名称，TUI 添加 Agent 必须拒绝重名。本文扩展 RFC-0012 的配置、过滤与管理契约；其他 Skill discovery、invocation、历史与同步规则保持其原有权威。

目前 Skill manager 可以按 target 配置适用范围，运行时也会排除 Agent 的 `skill` permission 明确拒绝的条目，但用户不能在一项 Skill 上直接选择哪些 Agent 应看到它。为特定评审 subagent 准备的审稿流程因此容易进入主 Agent 或实验 Agent 的目录，增加无关上下文，也容易被误用。

本设计增加与 target scope 并列的 Agent scope。用户在 `/skills` 管理每项 Skill 的可见 Agent；primary Agent 和 subagent 使用相同身份匹配规则。Agent 仍然按任务决定是否加载可见 Skill，不因进入白名单而自动加载正文。

## 范围

目标：

- 在控制设备上按 Skill identity 保存 Agent 白名单，默认保持现有全部可见行为。
- `$` picker、model guidance、显式调用、隐式加载和兼容入口使用同一规则。
- 覆盖 primary、自定义 primary、subagent，以及 `mode: all` 的定义。
- 与 target scope、现有 permission 和手动 reload 边界兼容。

非目标：角色通配符或动态 Agent 分组、按 model/variant 筛选、Session 级覆盖、自动授予工具权限、配置同步、自动创建评审 Agent/Skill、自动 reload，以及 Web/Desktop 完整 manager。

可见性是发现和 Skill 加载约束，不是文件保密或执行沙箱。有文件读取权限的 Agent 仍可能通过原生文件工具读到相关文件；已经进入历史或由其他 Agent 分享的文本也不会因此消失。

## 1. 配置与身份

控制设备的全局 Skill 配置增加：

```text
skills {
  paths?: string[]
  urls?: string[]
  targets?: Record<SkillID, "*" | SkillTarget[]>
  agents?: Record<SkillID, "*" | AgentID[]>
}
```

`agents` 与 `targets` 使用同一个 RFC-0012 `SkillID`。它们不写入 `SKILL.md` frontmatter，不改写 Agent 的 permission，也不按 Skill 显示名称绑定，因此同名 Skill 可以有不同可见范围。

| 值                                  | 语义                        |
| ----------------------------------- | --------------------------- |
| 没有该 Skill 的配置项，或值为 `"*"` | 对全部当前及未来 Agent 适用 |
| `[]`                                | 对全部 Agent 隐藏           |
| `["build", "paper-reviewer"]`       | 仅对这些准确 Agent ID 适用  |

示例中的 ID 是示意身份；manager 从真实目录选取并写入 ID，用户不需要猜测 ID。

AgentID 复用执行时的 canonical identity：built-in 如 `build`、`plan`、`general`；manager 创建的 subagent 使用 RFC-0016 的稳定 ID。显示名与兼容 alias 不参加策略匹配。实现必须验证 legacy 和 V2 加载同一定义时得到相同 ID，不能创建第二套 Skill 专用 Agent identity。

- 修改显示名、model、variant、description 或 prompt 不改变白名单。
- 删除／暂时禁用 Agent 后保留已保存 ID，不扩大范围。恢复同一 ID 后重新匹配。
- 创建同名但不同 ID 的 Agent 不继承旧条目的授权。
- 未明确声明稳定 ID 的兼容定义沿用已有 identity 规则；手工改配置 key 或移动定义可能改变 ID，不能声称这种变化等同显示名改名。
- `mode: all` 的同一 Agent 在 primary 与 subagent 场景使用同一策略；v1 不对同一定义按调用角色再拆分权限。

只接受 `"*"` 或由非空 ID 构成的数组。数组去重并稳定排序；数组里的 `"*"` 不作为通配符。未知 ID 可以保留为 dormant entry，但不按近似名称或默认 Agent 匹配。

策略是 controller-global、device-local 配置，与现有 `skills.targets` 一样不进入 Session 或 Skill package sync。project config 中的 `skills.agents` 被忽略并产生来源明确的诊断；project 定义的 Agent 仍可由全局策略通过真实 ID 选择。

## 2. 有效可见性与执行校验

```text
visible(skill, target, agent)
  = discovered(skill)
    AND targetScopeMatches(skill.id, target)
    AND agentScopeMatches(skill.id, agent.id)
    AND existingAgentSkillPermissionIsNotDeny(skill.name)
```

白名单从不把 `deny` 改为 `allow`，也不跳过既有 `ask`。加载时继续执行现有 Session／Location 有效 permission 校验。新配置不重新定义 permission precedence。

“主 Agent”指当前执行的 Agent 定义，不是所有 Session 的特殊超级身份。子 Session 使用自己的 Agent ID 和执行 target 求值；不复制父 Agent 的可见目录，也不要求父 Agent 能看到子 Agent 专用 Skill。主 Agent 能委派某个 subagent 的规则仍由 RFC-0016 管理。

以下消费者必须共享 Core 的可用性解析，不能各自在 TUI 或工具描述中重复实现：

1. QuickStart 所选 target／Agent 的 preview。
2. Session 已接纳目录、`$` picker 与 `<available_skills>` guidance。
3. 显式 SkillID mention 的 admission。
4. 隐式 `skill({ name })` 的唯一名称解析和最新正文加载。
5. 仍受支持的 legacy slash／SDK 兼容调用路径。
6. 新建、恢复与切换到子 Session 时的目录初始化。

名称唯一性必须在有效可见集合内判断。被排除的同名 Skill 不能造成虚假的歧义，也不能在选中项失效时成为回退对象。手写准确名称或旧 SkillID 不能绕过 scope。

显式调用新增可识别的 `agent-inapplicable` 失败原因；隐式加载可沿用既有 inapplicable 分类，但用户信息必须说明当前 Agent 不适用。失败不会创建 invocation snapshot、准备远程 package，或因该调用额外读取／向模型返回正文；正常 discovery 为建立 digest 而读取文件不属于此处的加载动作。诊断不枚举其他 Agent 的私人配置。

人类 manager 可以列出未启用 Skill 并查看来源，属于管理视图。`includeInactive`、无 Agent 的 inventory 或管理预览不得成为模型加载的替代入口。

## 3. 保存、activation 与历史

保存更新配置及 registry invalidation，不自动调用 reload，不触发模型请求，也不终止正在执行的 turn。

- 新建或重新进入 Session 时，按现有 activation 流程接纳新目录。
- 用户主动执行 `/context` 的 Reload 时，同步刷新 Skill 目录；实现应验证该入口实际覆盖 Skill activation。
- 切换当前 Agent 时，从已加载 registry 与该 activation 的策略快照重新过滤，不重复扫描 Skill 文件系统。
- 普通 provider turn、工具 continuation 和压缩不主动发现新 Skill，也不因 policy 扩大而自动获得新条目。

与 RFC-0012 的调用前适用性复查一致，**收紧范围会阻止之后的新加载**，即使当前 picker 暂时仍显示旧条目；失败引导用户手动 reload。扩大范围则需要重新 activation 才能进入 admitted catalog。已开始的一次加载不承诺中途撤销。

因此必须区分已接纳的 catalog/policy snapshot 与加载时的当前约束：后者只能收紧本次已准入能力，不能借此引入未接纳条目。Agent switch 也不能借缓存丢失恢复已经收紧的权限。

已经接纳的 invocation snapshot 保持原内容；改 scope、切 Agent、fork 或跨设备续聊不会追溯清除正文。本功能不承诺隔离同一 Session 中先前 Agent 看过的信息。需要相互独立评审时，使用独立 Session 并控制实际共享的内容。

## 4. TUI 管理

复用 `/skills` 和 `Manage skills`，不增加一个平行的 Skill manager。维护者在实现验收前进一步确定以下展示和焦点契约：

- 每项 Skill 仅占一行：`Name | 当前属性 | State`，不为 Agent 摘要或重名诊断增加第二行。
- 顶部属性视图为 `Source / Targets / Agents`，默认 Source。Source 显示 `source_name, path`；路径来自管理目录的准确条目位置，允许将 home 缩写为 `~`，不可通过名称猜测路径。Source 只读。
- 列表焦点下第一次 Tab 仅把焦点移到当前视图名称，不改变视图；视图焦点下后续 Tab 向前轮换，左右键分别向前／向后轮换，首尾循环。
- 视图焦点下 Enter 或 Shift+Tab 返回原列表项；上下键返回列表并继续导航。输入搜索文字也回到列表。鼠标选择视图与键盘一致。
- 切换视图保留搜索、选中 Skill identity 与滚动位置，不重扫或修改配置。仅当前视图占属性列宽，长值在选中行内横向查看，其他行与状态列保持静止。
- 列表中 Enter：Source 打开只读来源详情，Targets / Agents 直接打开对应编辑器。`View content` 快捷键仍可查看 Skill 正文。保存后回到同一视图与 Skill；取消不写入。
- 具体路径仅随 `includeInactive` 管理快照返回，不加入普通 Agent catalog、guidance 或 portable admitted identity；读取来源信息无需为每行再次读取正文。

Agent access 子视图提供 `All agents` 与可搜索 checklist，标明 primary、subagent 或 both。用户按 **Agent 名称**选择；ID 只作内部值，不出现在 `/skills` 的列表、选项、详情、提示或错误信息中。所有可由用户选择或委派的定义均可管理，不能只取“当前父 Agent 可调用”的 subagent 子集。未知／已失效 ID 保留为不可用选项，有已知名称则显示名称，否则显示 `Unavailable Agent`，用户可明确移除；不得用 ID 或其缩写补位。

TUI 添加 Agent 时必须检查显示名称唯一性，覆盖 primary 与 subagent，包括 built-in 与 hidden 定义。名称以 NFKC 规范化、去掉首尾空白并忽略大小写后比较；重名则保留输入并拒绝创建，说明名称已存在。后端定义写入在既有 catalog lock 内重复校验，避免并发添加和直接 API 绕过。编辑改名也遵循同一规则，排除正在编辑的自身 ID。删除后的名字可以重新使用，但新定义不得复用旧 identity。

已有文件或配置中的重名不自动改名或删除。`/skills` 可用来源标签提示歧义；不能明确区分时禁用歧义选项并提示先改名，不能退回显示 ID 或按顺序选择。已保存策略保持不变。

内部 title／summary／compaction 等 maintenance 定义不作为普通用户选项；自定义的 hidden subagent 不仅因 hidden 就被遗漏。已保存但不在当前 Location 目录中的 ID 仍保留并解释，不能自动清理或勾选替代项。

正常保存不增加确认弹窗；取消不写入。异步更新保留焦点和勾选草稿；revision conflict 不覆盖并发修改。成功后的短提示说明重新进入 Session 或手动 Reload 生效，不自动代用户执行。

当前 target 或 permission 仍会影响实际使用。详情可以说明相应限制，但不能因设置白名单便显示为已获完整执行权限。

## 5. 服务、持久化与失败处理

建议沿用现有类型与端点组织：

- Schema：`Skill.AgentScope`、`Skill.AgentScopeUpdate`，settings snapshot 增加 `agents`。
- Core：`SkillSettings.updateAgentScope(skillID, scope, expectedRevision)`；同一可用性解析供 catalog、guidance、admission、resolver 使用。
- Protocol／Server：`PUT /api/skill/settings/:skillID/agent-scope`，payload 为 `{ scope, expectedRevision }`。
- Client：通过 `packages/client` 的 `bun run generate` 生成，不手改生成产物。
- TUI：从 typed Agent catalog 获取候选；不读写文件、不解析 Markdown、不依赖原始模型／permission 数据。

Settings 服务仍为 controller-global。Location-scoped Agent 目录和 missing-ID 判断由消费端的 Core／Server workflow 合成，不能为了读取全局 Skill 设置而启动任意远程 Location。Agent 定义不可用时设置原值可读，候选刷新失败显示诊断，不能被解释为“没有 Agent”。

复用既有锁、expectedRevision/CAS 和原子 JSONC 写入。修改一个 scope 保留其他 Skill 的策略、discovery 配置、未知字段与注释；reset discovery 保留 `targets` 和 `agents` dormant overrides。移除 Skill 不隐式删除其 Agent scope，重新导入相同 SkillID 恢复原值。

无配置项是合法默认；读取失败或格式错误不是默认。对可定位到某 Skill 的非法 scope，该 Skill 不得回退成 all；若整个 `skills.agents` 无法验证，则新调用停止并显示配置诊断。其余合法配置可继续工作；已有历史保留。保留最后有效的 catalog 仅用于恢复／展示，不允许跳过当前加载校验。

scope 只使用 controller 配置，不增加 Rexd 协议、目标端配置或 Skill 文件传输方式。必须在 package materialization 之前完成适用性校验。

## 6. 兼容与交付

未配置 `skills.agents` 的现有用户保持原行为，无需迁移 Agent、Skill 或历史数据。不引入数据库迁移和新的云同步 payload。显式 allowlist 不会自动包含未来 Agent；`"*"` 会。

这是一项框架能力，评审 Agent 和审稿 Skill 的创建属于后续用户配置任务。不得把示例中的 paper-reviewer、model 或 target 自动写入用户全局配置。

接受本文后，建立单一可交付 implementation issue：Schema/Core/Protocol/Server/TUI 与生成产物在同一任务中完成，避免只有面板没有调用校验的部分交付。相关 issue #481 的身份边界和 #491 的缓存边界只作依赖参考，不趁机进行全局重构。

## 7. 验收

1. 默认、`"*"`、空列表、单 Agent、多 Agent 及重复输入行为明确；旧配置无变化。
2. built-in primary、自定义 primary、manager subagent、`mode: all` 均按执行 ID 过滤；改显示名或 model/variant 不改变结果。
3. 目标匹配、Agent 匹配、permission 的交集覆盖所有组合；既有 deny/ask 不被弱化。
4. 同一 Skill 只给 paper-reviewer 时，build/plan 的 picker 和 guidance 不包含它；独立 reviewer 子 Session 可以加载，父 Session 不必可见。
5. 旧 mention、手写 name、同名 Skill、兼容入口和 child Session 路径均不能绕过；失败不新建 invocation、向模型输出正文或 materialize package。
6. Agent 删除／禁用／同名重建、未知 ID、同 ID 恢复、project 定义及兼容 identity 变化有回归覆盖。
7. 保存不 reload；re-enter 和用户 Reload 应用变更；Agent switch 不重复扫描；收紧阻止新加载，扩大不越过 admission；历史正文不被删除。
8. 非法配置、不可读设置、候选加载失败、并发 CAS、JSONC 保留及 discovery reset 有失败路径测试。
9. manager 在窄／默认／宽终端可用，primary/subagent/both 可辨识；按名称选择，所有 Agent 展示与错误均不泄漏 ID。未知项、旧重名、取消、保存冲突与 selection 保留有 TUI 证据。
10. TUI 创建及后端写入拒绝同名 Agent，包括 primary 名称、大小写／空白／Unicode 等价名称与并发添加；编辑自身同名允许，改为其他定义的名称拒绝；拒绝不写入文件或配置。
11. local 与 Rexd target 的策略交集通过合同测试；没有新增控制端执行或远程传输旁路。
12. 公共生成产物一致，相关 package 的 `bun typecheck` 及行为测试通过。
13. 从干净的准确 PR head 构建 Mac candidate，交付二进制及 `opencode-transit.build.json`，用隔离配置验证 primary／reviewer 子 Session 的真实目录与拒绝行为，并提供 TUI 截图或录屏。默认不安装、不覆盖系统二进制。

按 testing workflow，本变更不涉及 sync、Windows 路径或 transport 实现，Windows 非默认必测项。若实现扩大到 Rexd transport/materialization 或平台相关代码，则增加相应真实 target／平台验收，不能以 Mac 通过推断其他平台通过。文档草案本身只需格式、链接与契约检查。

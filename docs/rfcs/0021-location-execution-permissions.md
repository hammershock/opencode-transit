---
id: 0021
title: Location-derived Execution Permissions
status: accepted
authors:
  - hammershock
created: 2026-09-23
updated: 2026-09-23
implemented-by: []
depends-on:
  - 0002
  - 0009
  - 0010
  - 0012
  - 0016
supersedes: []
superseded-by: []
---

# RFC-0021：Location 派生执行权限

## 状态与范围

**Accepted。** 设计任务为 [#509](https://github.com/hammershock/opencode-transit/issues/509)，背景为 [#481](https://github.com/hammershock/opencode-transit/issues/481)。维护者选择第六节的**保守升级**，并在补全契约后确认开始下一阶段实现。实施按第七节的独立任务推进；接受设计不代表迁移已经上线，也不授权开发过程中修改生产数据。

目标是让普通消息、结构化 Skill mention、主 Session 和子 Session 的工具执行使用同一权限语义，并使切换执行位置不会复制另一台机器的路径许可。它是指定 Target 委派的基础，不实现 RFC-0018 的 Task 参数，也不替代该 RFC 的接受流程。

不修改共享用户配置、项目指令或 OS 权限，不新增全局自动授权。Location 和路径许可不是安全沙箱，工具仍在宿主用户的权限下运行。

## 一、当前证据

以下描述基于 `dev @ 7865230fe5`，不是目标架构：

| 入口或数据               | 当前行为                                                   |
| ------------------------ | ---------------------------------------------------------- |
| TUI 新建 Session         | `v2.session.create` → Core Session                         |
| TUI 普通消息             | legacy Session prompt                                      |
| TUI 结构化 Skill mention | v2 Session prompt                                          |
| legacy 文件工具          | 桥接到 Core Location tool registry                         |
| legacy Task              | 创建 legacy child，并复制部分 parent Session permission    |
| #505 路径白名单          | 在 legacy `SessionShare.create` 写入 `session.permission`  |
| Core 授权                | `PermissionV2.configured` 只读取解析后的 Agent permissions |
| Core Session read view   | 不包含 legacy `permission` 字段                            |
| Instance 缓存            | directory-only，即使 `InstanceContext` 已携带 target       |

直接把 legacy `session.permission` 合并进 Core 会使过去未被 Core 消费的 allow 生效。简单删除所有像 Skill 路径的规则则可能删除用户自己编写的 allow。这两种操作都不是无语义变化的适配。

[#508](https://github.com/hammershock/opencode-transit/pull/508) 仅恢复新建 legacy Session 的显式规则优先级，不解决本文的跨入口、Agent 层级与历史状态问题。

## 二、状态归属提案

| 状态                              | 所有者与生命周期                  | 持久化/跨位置行为                                          |
| --------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| Agent 定义与显式配置权限          | 配置与 Agent definition           | 保留配置归属；展示 catalog 不启动目标文件系统              |
| 用户显式 Session policy           | Session                           | 可持久化；规则必须区分可携带动作与绑定执行位置的路径资源   |
| Skill/reference 自动路径 defaults | 当前 Location 的运行时策略解析    | 不写入新 Session event/part、sync、fork payload 或 export  |
| 父链 hard deny                    | Task admission 的既有权限继承边界 | 限制 child，不把 parent 路径 allow 直接复制到不同 Location |
| Saved approval                    | 现有 saved-permission 服务        | 保留其既有作用域，不能覆盖有效显式 deny                    |

跨 target 的路径 allow 必须重新在目的 Location 解释和授权，不能因两个机器恰好有相同目录字符串而等价。父路径 deny 的跨 target 解释必须与 RFC-0018 一起明确，不通过修改字符串或抛弃限制来猜测其含义。

运行时 defaults 的缓存 key 包含完整 Location identity 与相关目录/策略版本。Session rebind、Skill catalog reload、reference 配置更新和 materialized package 生命周期变化使对应结果失效。失效重建失败不能回退到 controller 路径或上一 target 的许可。

## 三、合并与执行边界提案

为所有执行入口提供一个 Core-owned effective-policy 解析边界。legacy 工具在兼容边界转换输入和错误，不在自己的 registry 中另建授权决策。Core tool registry 继续只负责注册、定义和 settlement；执行授权仍由捕获 Location permission service 的 leaf 发起。

普通规则保持有序 last-match 语义，推荐分层为：

```text
系统默认规则
  → 当前 Location 的自动路径 defaults
  → 显式配置与 Agent 规则
  → 显式 Session override
  → 符合既有作用域的 saved approvals
```

自动 defaults 不具有用户 override 身份。显式规则内部的 allow/ask/deny 顺序保持不变，不用“任何 deny 永远优先”的通用算法替代已有语义。saved approvals 不越过合并后的显式 deny。Task 父链/child-definition 的 hard-deny 约束按 RFC-0016 单独保留，不能靠追加自动 allow 消除。

以下冲突结果作为提案的验收契约，不能由实现自行选择：

- Location 自动 allow 与 Agent/Session 显式 deny 或 ask 冲突：显式规则生效。
- 非 hard-deny 的普通显式规则：后层及同层后匹配规则生效，保留 last-match 语义。
- Task admission 已捕获的父链 hard deny，或 child definition 对该资源的有效 deny：Session allow、自动 defaults 和 saved approval 都不能解除。
- child definition 内部仍先执行其有序规则；不是只要历史数组曾出现 deny 就永久禁止。
- saved allow 与合并后的有效显式 deny 冲突：deny；与普通 ask 冲突时，只有作用域有效的 saved approval 才可放行。

本文保留 admission 时捕获父限制的边界，不增加持续扫描父 Session 的新执行控制器。跨 target 的路径限制解释由 RFC-0018 明确后才能交付跨位置继承。

Catalog visibility 和执行授权仍是不同操作，但两者使用同一有效策略输入。隐藏工具不构成授权，展示 capabilities 也不授予权限。`/context` 可解释有效结果及非敏感来源，不输出凭据或原始配置全集。

Core 不依赖 opencode 包。共享策略读取不应迫使 current Schema 依赖 V1 类型；选择内部 Session policy read model 或新的 current 契约时，在实现 issue 中写明是否改变 Protocol/SDK。产生 public contract 变化时运行仓库生成器。

## 四、Skill 与 reference 路径

Skill catalog 的 source path 是 controller 发现结果，不能充当远端自动 allow。现有 Rexd `SkillPackageAccess.prepare` 已将 package snapshot materialize 到 target，返回实际 digest package path；复用这条传输路径。

推荐仅为已成功 prepare、仍在有效生命周期中的精确 package 目录建立运行时 default，不授权整个 staging root。default 的使用资格属于发起 prepare 的 Session 和实际 Location；共享物理 package 或 Location 服务不意味着另一 Session 自动获得许可。prepare 失败或 attachment 失效不得留下新增许可。built-in inline Skill 没有 package path 时不产生路径 default。

这意味着“catalog 中存在 Skill”与“已经加载其 package”是不同状态；相较于自动放行 catalog 中所有 Skill 目录，这是需要接受的行为收紧。显式配置仍可表达用户确实需要的额外访问。

Reference 不是 Skill package。它沿用自身 Location-aware 解析契约；默认许可来自目的地的已解析 reference，不能把 controller reference 目录直接替换成 Skill staging root。未解析、不可用或错误 target 的 reference 不产生许可。

两类 defaults 均只省略对应的 external-directory 询问，不隐式放行被拒绝的 read、edit、bash 等工具动作，也不绕过 provider roots。

## 五、Location 与兼容 Instance 边界

controller 配置上下文与 execution Location 必须显式区分。不能只给 directory-only Instance cache 加一个 target 字段，却继续用同一个 directory key 复用其捕获的服务。

实现优先复用完整 `Location.Ref` 的服务映射。仍承载 execution-sensitive 状态的 legacy cache、失效和 dispose 必须使用一致的完整身份；纯 controller 配置缓存不因远端同名路径而被误认为远端文件系统。禁止只修 load key 而留下 directory-only dispose 或下游缓存。

测试必须同时放入 local、Rexd A、Rexd B 的相同目录字符串，验证读取、权限、reload 和 disposal 互不串用。修复不应顺便扩大到 [#398](https://github.com/hammershock/opencode-transit/issues/398) 的全局事件协议改造。

## 六、历史规则迁移：保守升级

#505 已写入的规则没有 provenance，自动 allow 与用户 allow 可能字节完全相同。不能从 path glob、数组位置或当前 Skill catalog 推断来源；旧 event history 也不能原地重写来假装从未保存过它们。

维护者已选择**保守升级**，不采用“所有历史规则都视作用户许可”的兼容优先方案。以下为该选择的具体契约。

### 6.1 保留历史与限制

原始 legacy rules 和 event history 不删除、不重排、不原地改写。读取旧 Session 时，根据有序原始规则计算稳定 digest，建立 migration view；不修改 transcript，也不为了迁移重新执行 provider turn。

对缺少可信来源的规则，allow 进入待确认集合；deny 和 ask 保留相对顺序，作为迁移期的 Session 限制参与解析。排除未知 allow 可能使早先的 deny 重新生效，这是保守升级的明确行为，不假称旧权限完全不变。

未知 allow 本身既不授权也不额外禁止：当前配置、目的地 defaults 或有效 saved approval 已经允许的操作可以继续。没有其他许可时走现有工具询问流程；有效 deny 仍然拒绝。打开历史或发送消息不要求先通过一个全会话迁移弹窗，也不因迁移启动新的 Agent 回合。

普通工具的 Allow once/Always 继续拥有原作用域，不自动确认整份历史策略。Agent、项目文件、同步事件或模型生成的回复不能代表用户完成策略确认。

### 6.2 确认范围与状态

提供独立、用户发起的 Session 权限复核动作，展示原始规则、实际绑定位置以及确认后的有效变化。用户可逐条接受未知 allow，或明确不保留它；提交结果是一份可预览的新显式策略，不能用“继续会话”隐式接受全部规则。

确认至少绑定：Session ID、预期 policy revision、原始有序规则 digest、实际完整 Location 与 location revision，以及选择结果。未知/未解析 Location 不能被默认成 local 后确认。新策略区分非路径动作与位置绑定资源；改变 target 或 directory 时旧路径 allow 不自动适用。

```text
无 legacy rules → current
存在未确认 legacy allow → pending
pending + 提交完整选择且版本匹配 → reviewed
pending + 取消复核 → pending（原状态不变）
reviewed + legacy rules 或 Location 发生变化 → pending
```

没有 legacy allow 时，不引入无意义的确认；原有限制进入 current 规则视图。选择“不保留”只影响新的有效策略，原始历史仍可审计。相同版本和位置的已完成确认不会每次进入 Session 重新询问。

### 6.3 并发、幂等与失败恢复

复核提交使用请求幂等键及 compare-and-swap；检查规则 digest、policy revision 和 location revision 后，将确认事件与策略投影原子提交。任何一项过期都返回 conflict，不接受旧面板覆盖新限制。与 rebind、删除及策略写入使用同一 Session mutation 序列化边界。

提交前取消、校验失败、数据库失败或进程退出不激活任何选中的 allow。事件与投影提交成功但客户端未收到响应时，完全相同的请求重试返回原结果；同一幂等键不同内容返回 conflict。恢复和同步重放不得产生重复确认、部分许可或自动工具执行。

解析到损坏或未知版本的 policy 数据时，执行返回可诊断的 policy-unavailable 错误，不退回忽略旧 deny 的默认规则。历史读取保持可用。实现必须有提交前失败、提交后丢响应、重启与竞争测试，不能仅凭 UI 状态认为授权已经生效。

### 6.4 旧客户端写入

新的 server 在 legacy Session permission 写入口也维护上述版本和 digest。与已确认 snapshot 完全相同的写入不使确认失效；内容不同的未标记写入产生新的待复核版本，其 deny/ask 立即按限制使用，allow 不因来自旧客户端而获得可信来源。

新的、明确用户确认的权限编辑必须使用带 revision 与来源的 current workflow。不能把任意 legacy API 请求标记为“用户已确认”。同一策略的两个并发写入只能有一个版本胜出。

旧 server 无法执行本契约；保证只覆盖升级后的执行端。回退旧二进制不等于安全回滚策略语义，发布说明应明确此边界。旧 server 产生的新规则在升级端重放后仍按未知来源处理。

### 6.5 Fork、位置变化与同步

Fork 保留原始策略来源和选择记录作为历史依据，但新 Session 不自动继承未知 allow 的确认资格；对该 child 重新建立 migration view。Task 已知来源的父链限制仍按 admission 契约继承，不能被这条 fork 规则清除。

确认事件可作为 Session 的版本化事实同步，但**另一设备收到确认事件不等于获得本机执行授权**。实际激活资格绑定确认设备和该设备解析后的完整 Location；同步数据只携带现有可移植位置身份和必要的非敏感确认来源，不携带设备本地 target ID、SSH 配置或凭据。

接收设备、重新绑定位置或无法验证原位置的 Session 保留确认记录用于解释，并在执行侧保持 pending；不能靠目录字符串相同、portable label 相同或从同步 history 读到 allow 自动激活。完整 Location 匹配时，本机重启可以恢复已提交的确认，而不是再次要求相同确认。

策略确认与 sync 顺序无关地收敛：旧规则 digest 与确认 snapshot 不一致时，确认保持历史事实但不适用于新版本；离线确认、冲突写入、重复投递都不得让过期 allow 复活。

这项设计不授权对生产数据库执行清理脚本。上线迁移必须可解释、可回放，历史保留与新执行策略切换在同一验收矩阵中验证。

## 七、实施与验收

接受后按可独立审查的任务交付，GitHub issues 负责实时状态：

1. [#512](https://github.com/hammershock/opencode-transit/issues/512)：历史 migration view 与 current policy read model，覆盖 provenance、版本和重放。基础层不启用 execution cutover，不直接读取旧 allow 后立即放行。
2. [#513](https://github.com/hammershock/opencode-transit/issues/513)：独立关闭 execution-sensitive Instance/cache 身份缺口，验证同路径多 target、reload 和 dispose；不依赖 #512 的实现，先完成 controller/execution 状态归属清单。
3. [#514](https://github.com/hammershock/opencode-transit/issues/514)：消费 #512/#513，完整交付用户复核 workflow 与 Core/legacy effective-policy 一致性。包括 Session+Location 派生路径生命周期、移除新 baking、冲突 UI、两个创建入口和两个 prompt 入口的验证。不能先启用缺少复核/恢复入口的半套迁移。
4. 同步更新 `/context` 与 capability 消费者，再推进已接受的 destination Task 契约。不会把全部 upstream V2 迁移设为前提。目的地参数仍由 RFC-0018 和 [#466](https://github.com/hammershock/opencode-transit/issues/466) 跟踪。

每个实现 issue 明确依赖；共享文件一次只有一个 active owner。正在进行的 leaf-tool 修复 [#507](https://github.com/hammershock/opencode-transit/issues/507) 不应被本设计改动混入。

最低验证矩阵：

- 自动路径 allow 不能覆盖 Agent/Session 显式 deny 或 ask；saved 不能越过有效 deny；父链约束在 child 中仍成立。
- 普通消息与结构化 Skill mention 对同一资源给出一致结果；新建、旧 Session、fork 与恢复均覆盖。
- Skill prepare 成功/失败/release，reference reload 和 target 离线不遗留错误许可。
- 三个 target 同路径不串用；child 目的地不同，parent 的环境和路径 allow 不进入 child。
- 新派生路径不出现在 raw Session/sync/export；旧记录保留且迁移可解释、幂等、失败不半应用。
- 迁移取消、逐条接受/不保留、过期 revision、旧客户端更改、fork、提交后丢响应及 sync 乱序均覆盖；其他设备不能自动激活收到的确认。
- 精确提交 clean Mac 候选与真实 Mac → Rexd workflow；改变 sync/迁移时增加实际双设备验证。未测试平台明确记录。

文档阶段只进行元数据、链接和格式检查。不会安装二进制、修改已运行 Session，也不会用本文替代真实工作流验收。

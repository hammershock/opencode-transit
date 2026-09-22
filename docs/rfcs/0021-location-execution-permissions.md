---
id: 0021
title: Location-derived Execution Permissions
status: draft
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

**Draft，尚未授权 runtime 实现。** 设计任务为 [#509](https://github.com/hammershock/opencode-transit/issues/509)，背景为 [#481](https://github.com/hammershock/opencode-transit/issues/481)。本文提出权限状态归属和迁移方案；第六节的历史规则处理必须得到明确选择后才能接受。

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

实现任务必须用冲突矩阵证明 Agent、Session、saved 与父链边界的结果，尤其覆盖 Session allow 与 child-definition deny 的冲突；若现有契约无法确定结果，先修订本文而不是在实现时决定。

Catalog visibility 和执行授权仍是不同操作，但两者使用同一有效策略输入。隐藏工具不构成授权，展示 capabilities 也不授予权限。`/context` 可解释有效结果及非敏感来源，不输出凭据或原始配置全集。

Core 不依赖 opencode 包。共享策略读取不应迫使 current Schema 依赖 V1 类型；选择内部 Session policy read model 或新的 current 契约时，在实现 issue 中写明是否改变 Protocol/SDK。产生 public contract 变化时运行仓库生成器。

## 四、Skill 与 reference 路径

Skill catalog 的 source path 是 controller 发现结果，不能充当远端自动 allow。现有 Rexd `SkillPackageAccess.prepare` 已将 package snapshot materialize 到 target，返回实际 digest package path；复用这条传输路径。

推荐仅为已成功 prepare、仍在有效生命周期中的精确 package 目录建立运行时 default，不授权整个 staging root。prepare 失败或 attachment 失效不得留下新增许可。built-in inline Skill 没有 package path 时不产生路径 default。

这意味着“catalog 中存在 Skill”与“已经加载其 package”是不同状态；相较于自动放行 catalog 中所有 Skill 目录，这是需要接受的行为收紧。显式配置仍可表达用户确实需要的额外访问。

Reference 不是 Skill package。它沿用自身 Location-aware 解析契约；默认许可来自目的地的已解析 reference，不能把 controller reference 目录直接替换成 Skill staging root。未解析、不可用或错误 target 的 reference 不产生许可。

两类 defaults 均只省略对应的 external-directory 询问，不隐式放行被拒绝的 read、edit、bash 等工具动作，也不绕过 provider roots。

## 五、Location 与兼容 Instance 边界

controller 配置上下文与 execution Location 必须显式区分。不能只给 directory-only Instance cache 加一个 target 字段，却继续用同一个 directory key 复用其捕获的服务。

实现优先复用完整 `Location.Ref` 的服务映射。仍承载 execution-sensitive 状态的 legacy cache、失效和 dispose 必须使用一致的完整身份；纯 controller 配置缓存不因远端同名路径而被误认为远端文件系统。禁止只修 load key 而留下 directory-only dispose 或下游缓存。

测试必须同时放入 local、Rexd A、Rexd B 的相同目录字符串，验证读取、权限、reload 和 disposal 互不串用。修复不应顺便扩大到 [#398](https://github.com/hammershock/opencode-transit/issues/398) 的全局事件协议改造。

## 六、历史规则迁移：待决定

#505 已写入的规则没有 provenance，自动 allow 与用户 allow 可能字节完全相同。不能从 path glob、数组位置或当前 Skill catalog 推断来源；旧 event history 也不能原地重写来假装从未保存过它们。

可选策略：

1. **保守升级（推荐）**：保留原始历史规则和已有显式拒绝；为缺少来源的旧 allow 标记待确认状态，在统一执行器中新启用它们之前要求一次明确的策略确认。未确认时使用现行配置、可验证的目的地 defaults 和常规询问流程，不自动扩大许可。确认结果形成新的版本化策略事件，旧 history 保持可回放。
2. **兼容优先**：将所有历史 Session 规则都视为显式用户规则，在原绑定 Location 中继续生效。无需确认，但会把 #505 的自动 allow 永久提升为用户权限，且 Core 开始消费它们会改变实际执行授权。必须明确接受这个代价，不能称作行为不变。

两种策略都不授权批量修改生产数据，也不允许历史路径 allow 随跨 target resume/rebind 自动迁移。迁移状态、fork、离线同步、旧客户端写入与重放幂等性必须有独立测试；若无法识别来源设备或原绑定位置，则不得把未知位置解释为当前本机。

接受本文前需选定一个方案，并补全旧客户端与失败恢复契约。本文当前不宣布上述任一方案已被接受。

## 七、实施与验收

接受后按可独立审查的任务交付，GitHub issues 负责实时状态：

1. 明确历史迁移和 current policy read model；覆盖 provenance、版本和重放。不得直接读取旧 allow 后立即启用。
2. 实现共享 effective-policy 解析，接入 Core leaf 与 legacy adapter。用两个创建入口和两个 prompt 入口证明相同结果。
3. 将路径 defaults 迁到 Location/runtime owner，移除新 Session 创建时的 baking；接入 Skill prepare/release 与 reference 生命周期。
4. 关闭 execution-sensitive Instance/cache 身份缺口，验证同路径多 target、rebind、reload 和 dispose。
5. 更新 `/context` 与 capability 消费者，再推进已接受的 destination Task 契约。不会把全部 upstream V2 迁移设为前提。

每个实现 issue 明确依赖；共享文件一次只有一个 active owner。正在进行的 leaf-tool 修复 [#507](https://github.com/hammershock/opencode-transit/issues/507) 不应被本设计改动混入。

最低验证矩阵：

- 自动路径 allow 不能覆盖 Agent/Session 显式 deny 或 ask；saved 不能越过有效 deny；父链约束在 child 中仍成立。
- 普通消息与结构化 Skill mention 对同一资源给出一致结果；新建、旧 Session、fork 与恢复均覆盖。
- Skill prepare 成功/失败/release，reference reload 和 target 离线不遗留错误许可。
- 三个 target 同路径不串用；child 目的地不同，parent 的环境和路径 allow 不进入 child。
- 新派生路径不出现在 raw Session/sync/export；旧记录保留且迁移可解释、幂等、失败不半应用。
- 精确提交 clean Mac 候选与真实 Mac → Rexd workflow；改变 sync/迁移时增加实际双设备验证。未测试平台明确记录。

文档阶段只进行元数据、链接和格式检查。不会安装二进制、修改已运行 Session，也不会用本文替代真实工作流验收。

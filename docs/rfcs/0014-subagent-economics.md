---
id: 0014
title: Economics-aware Subagent Routing
status: accepted
authors:
  - hammershock
created: 2026-09-15
updated: 2026-09-15
implemented-by: []
depends-on:
  - 0007
  - 0011
  - 0012
supersedes: []
superseded-by: []
---

# RFC-0014：面向成本与用量的 Subagent 路由上下文

## 摘要

OpenCode Transit 可以在显式实验开关开启后，向主 Agent 提供可调用 model-bound subagent 的价格、可靠计费方式、少量版本化 benchmark 与 provider usage，使主 Agent 在能力之外考虑实际成本和剩余额度。信息只属于控制设备的运行时上下文：不写入 Session durable history、普通 transcript、导出或同步数据，也不改变 Session Location。

静态目录在 Session activation 时异步预取并以可替换的 `<available_subagents>` 块提供；Task interaction 完成后，当前调用的 token、可计算的 list-price 成本增量与一个 provider 配额 meter 以一次性 `<subagent_usage>` 块提供给父 Agent 的下一次 continuation。任何数据缺失、过期或请求失败都必须显式降级为 unknown/unavailable，且不能阻塞 Session 激活、Task 调用或 provider turn。

## 目标

1. 主 Agent 能比较全部可调用且绑定模型的 subagent，而非只看到名称和描述。
2. 价格、计费方式、能力指标与剩余额度保持不同语义，不合成为虚构总分。
3. 外部 benchmark 采用免费、可归属、版本化的严格数据适配器。
4. 动态账户用量遵守 RFC-0007 的 credential、安全和 provider adapter 边界。
5. v1 先接入当前 Task 链，同时定义可供 Session V2 复用的 Core contract。
6. 用户能在 `/context` 检查目录、来源、刷新状态和实际进入 Agent context 的文本。

## 非目标

- 由 OpenCode 自动选择 subagent 或实现固定的成本优化算法；
- 将 benchmark 视为质量保证，或用一个综合排名替代任务判断；
- 读取账单网页、浏览器 cookie、外部 CLI 登录态或未由 OpenCode 管理的 credential；
- 猜测订阅、token plan、预付额度或免费模型的等价美元价格；
- 向 provider 购买额度、充值、切换账户或修改计费设置；
- 把目录、usage、Task 成本或额度状态写入 Session durable context、sync、fork 或 export；
- 在 v1 为任意第三方插件开放稳定的 economics API；
- 让 benchmark 网络请求或 usage 请求成为 prompt/Task 的前置条件。

## 启用与兼容

功能由 `experimental.subagent_economics: true` 显式启用，默认关闭。关闭时不获取 benchmark，不建立 economics catalog，不向模型注入新块，`/context` 只报告 disabled；Task 与 RFC-0007 行为保持不变。

本 RFC 对 RFC-0007“usage 不进入 Agent context”作唯一、窄化的例外：只有显式启用功能后，经过 Provider Usage 公共 schema 归一化的一个非敏感 meter，以及 Task interaction 的本地 token/cost delta，可以进入设备本地、一次性的路由提示。它们仍不得进入 Session history、durable ModelContextSnapshot、同步、导出、tool result 或用户消息。RFC-0007 的 credential 来源、adapter、缓存、脱敏与失败隔离要求全部继续适用。

## 领域模型

Core 拥有 provider-neutral schema，legacy Task 与 Session V2 消费同一 contract：

```text
SubagentEconomicsCatalog {
  revision
  activatedAt
  status: disabled | loading | ready | partial | error
  agents: SubagentEconomics[]
  diagnostics[]
}

SubagentEconomics {
  agent
  model { providerID, modelID }
  pricing {
    input?, output?, cacheRead?, cacheWrite?
    tiers[]?
    currency
    unit
    source
    status: available | unavailable
  }
  billing {
    mode: pay_as_you_go | subscription | token_plan |
          prepaid_credits | free | unknown
    source?
  }
  benchmarks: BenchmarkMetric[] // maximum two
  usage?: ProviderUsageMeter
}

BenchmarkMetric {
  dimension: coding | research | general
  benchmark
  value
  unit
  source
  observedAt
  datasetVersion
  modelVariant
  attribution
  status: fresh | stale
}
```

价格使用 model catalog 已有的结构化值和 tier，不把缓存价格或长上下文 tier 折叠成单值。无法从 authoritative provider/config metadata 确认 billing mode 时必须为 `unknown`；provider 名称、模型名、余额单位或本地价格不能作为推断证据。

每个模型最多选择两个 benchmark metric，且 dimension 不重复。v1 来源为 Chatbot Arena 的免费机器可读数据与 LiveCodeBench 官方数据；适配器分别版本化，保留来源 URL、观测日期、dataset version、精确 model variant 与 attribution。只接受数值 JSON 字段，禁止把榜单中的自由文本、模型描述、HTML 或远程指令拼入 prompt。

## 身份匹配与 benchmark 选择

外部记录只通过 canonical provider/model identity 或代码内显式审查的 alias 表匹配。禁止 fuzzy matching、仅按显示名匹配或自动把未知后缀视为同一模型。无法确认 exact variant 时不展示 metric。

Arena 提供 general 维度；LiveCodeBench 提供 coding 维度。没有可验证 research 指标时保持缺失，不能用 general 或 coding 重命名。若同一维度存在多个候选，adapter 使用固定、测试覆盖的选择规则；不得因远端排序变化而改变语义。

## Activation 静态目录

Session 新建、resume 或切回前台时，controller 建立该次 activation 的目录，生命周期与 RFC-0012 Skill Catalog 相同，但两者是独立来源。候选集合是当前 Agent registry 中全部可由 Task 调用、具有显式 model binding 且通过 permission/visibility 过滤的 subagent。未绑定模型、primary-only、hidden 或不可调用 Agent 不出现。

激活不能等待网络：先发布 `loading` 的本地目录，并并发预取 benchmark 与 Provider Usage。结果在下一安全 provider-turn boundary 替换为 ready/partial/error。静态块最多注入一次；Task description 只说明应参考 `<available_subagents>`，不得复制目录。

```xml
<available_subagents status="partial" refreshed_at="...">
  <subagent name="..." model="provider/model" billing="unknown">
    <pricing ... />
    <benchmark dimension="coding" ... />
    <usage ... />
  </subagent>
</available_subagents>
```

块采用固定 XML renderer、稳定排序和转义。远端字符串不得成为 tag name 或未转义 attribute。完整 guidance 设置明确的字节上限；超限时先丢弃 benchmark，再丢弃 usage，最后按稳定 agent order 截断，并写入 truncated 状态。实现 issue 必须确定不高于现有 system guidance 可安全承受的上限。

## Task interaction 动态用量

每次 foreground、background 或并发 Task interaction 完成后，Task runtime 从该 child interaction 的实际 message usage 计算输入、输出、reasoning、cache read/write token delta。只有存在适用的 model catalog list price 时才计算 `estimated_list_cost`，并明确标注 estimated/list；它不是 provider 实际扣费，也不能用于 subscription/token plan 的余额换算。

Provider Usage 在 Task 完成后异步 revalidate；不延迟 Task completion。可用时选择与该 child 实际 provider/account/scope 对应的一个稳定 meter，优先 remaining/reset 信息。动态结果写入 controller-local pending guidance，并只在父 Session 的下一次 continuation 消费一次：

```xml
<subagent_usage>
  <interaction agent="..." model="..." execution="foreground|background">
    <tokens input="..." output="..." ... />
    <estimated_list_cost amount="..." currency="..." />
    <provider_meter ... />
  </interaction>
</subagent_usage>
```

该块不得加入 Task tool result、普通 message part 或 durable event。并发完成按稳定 interaction identity 排序并合并，整体上限为 4 KiB；超限保留每个 interaction 的核心 token delta，省略成本和 meter，并标注 truncated。重试必须能从当前 child message usage 与 controller-local interaction identity 幂等重建，不能重复累计。

若父 Session 在结果可消费前退出、切换设备、崩溃或被 compact，pending guidance 可以丢失；这是有意的 device-local advisory state，不允许为了恢复它扩大 durable Session schema。

## 获取、缓存与失败

- benchmark cache 存在控制设备本地，fresh TTL 为 24 小时，最近成功结果最多 stale 7 天；超过 7 天视为 unavailable；
- adapter 请求使用短超时、响应大小限制、严格 content type/schema 校验、固定并发上限和 in-flight 合并；
- activation 默认使用 fresh/stale cache 并后台刷新；显式 refresh 绕过 fresh 判定但仍合并并限速；
- `/context` inspector 只读取当前 catalog/cache，不自行触发网络；
- usage 复用 RFC-0007 service/cache，不复制 credential 或原始 provider response；
- 任一 source 失败只产生脱敏 diagnostic，已有 stale 数据保留来源与时间；不得伪装成 0、free 或 unknown score；
- benchmark 数据不是可信指令。日志与 cache 不保存无关远端正文、credential、account 私密字段或完整 provider response。

## `/context` 与反馈

Session context API 增加 device-local 可选字段：

```text
subagentCatalog
subagentGuidance
subagentRefresh {
  status: disabled | loading | ready | partial | error
  startedAt?
  completedAt?
  diagnostics[]
}
```

这些字段不是 `ModelContext.Generation` 的一部分。TUI `/context` 显示每个 subagent 的 model、billing、价格、最多两个 benchmark、usage、来源时间、stale/unknown 与截断状态，并显示实际 renderer 输出。每次 activation 在刷新首次完成时最多发送一个 ready/partial/error toast；后续后台更新不重复打扰。disabled 不弹 toast。

## Location、同步与隐私

Economics registry、benchmark cache、provider usage、pending interaction delta 和 render guidance 全由 controller device 拥有。它们不通过 Rexd 执行，不复制到 Session Location，也不进入 RFC-0010 sync。远程 subagent 仍与父 Session 使用同一个 Location；本功能只帮助选择模型，不改变 Task 的 Location placement。

另一设备 resume 同一 Session 时必须以该设备当前 agent/model catalog、credential 和 cache 建立新 activation；不能沿用上一设备的价格、额度或 pending delta。`/context` 应明确标记这些字段为 device-local。

## 实现任务拆分

RFC 合并后按以下独立 issue 交付：

1. Foundation：实验配置、schema、registry、严格 renderer、activation lifecycle 与单元测试。
2. Context surface：Protocol/Server `/context` 字段、generated clients、TUI panel 与 activation toast。
3. Interaction usage：Task/V1 采集、pending one-shot guidance、Provider Usage revalidation 与 V2 可复用 contract。
4. Arena adapter：严格 schema、identity aliases、cache、license attribution 与 fixtures。
5. LiveCodeBench adapter：严格 schema、identity aliases、cache、license attribution 与 fixtures。

后续任务依赖 foundation；interaction usage 与两个 adapter 可在 foundation 合并后独立进行。Context surface 消费 foundation，并可在 adapter 缺失时完整展示 unknown/loading/error。

## 验收条件

1. 开关关闭时无网络、prompt、Task、Protocol 兼容性变化。
2. 所有 callable model-bound subagent 均稳定列出；不可调用或无 model binding 的 Agent 被排除。
3. pricing tier、authoritative billing mode、最多两个不同维度 benchmark 与一个 usage meter 保持独立且来源可检查。
4. activation 非阻塞；ready、partial、error、stale、unknown、truncated 均有测试。
5. exact identity/alias、schema drift、超时、过大响应、恶意字符串、缓存与 in-flight 合并均有 adapter 测试。
6. 每个 Task interaction 的 token delta 精确、成本明确为 list estimate；foreground、background、并发与 retry 不重复累计。
7. 动态块只进入下一次父 continuation，最大 4 KiB，随后清除。
8. 静态与动态信息均不出现在 Session event/message、数据库、sync payload、export、fork 或 Task result。
9. Provider Usage credential、account/scope 与 failure isolation 继续满足 RFC-0007。
10. `/context` 显示当前 device-local catalog、实际 guidance 和 refresh 状态；每次 activation 最多一个完成 toast。
11. Mac 与 `mywindows` 均通过 local 和 Rexd Session activation、Task foreground/background、离线 cache、provider failure、resume 与跨设备不继承验证。

## 安全检查

- fixture、日志、toast、context response 和 snapshots 不含 secret、authorization header 或原始账单响应；
- 外部 benchmark 只贡献经过 schema 验证的数值与固定 attribution；
- model/provider/agent label 均转义并受长度限制；
- 网络失败不扩大 Location 权限，不触发登录，不改变 provider 请求或模型选择；
- 任何自动选择或更强的计费推断都需要新的 RFC 修订。

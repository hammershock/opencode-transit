---
id: 0027
title: Persistent Goals and Hierarchical Research Plans
status: accepted
authors:
  - hammershock
created: 2026-10-02
updated: 2026-10-02
implemented-by: []
depends-on:
  - 0003
  - 0010
  - 0011
  - 0021
  - 0023
  - 0025
supersedes: []
superseded-by: []
---

# RFC-0027：持久 Goal 与分层科研计划

## 1. 状态、动机与范围

设计议题：[issue #726](https://github.com/hammershock/opencode-transit/issues/726)。维护者于 2026-10-02 委托完成设计，并明确决定下列三项产品选择；按其“决策后自动接受、随后停止”的授权，本文为 Accepted，本次仅交付文档。Accepted 不表示功能已经交付，`implemented-by` 在实际交付前保持为空。

本文遵循[设计宣言](../design-manifesto.zh.md)与[开发工作流](../development-workflow.md)，扩展 [RFC-0010](0010-encrypted-session-sync.md) 的 Session 数据契约及 [RFC-0011](0011-location-aware-model-context.md) 的上下文生产者，并在 §4 明确修订 [RFC-0025](0025-agent-session-interaction.md) 对 active Goal 的 idle 中断语义。[RFC-0021](0021-location-execution-permissions.md) 的授权、[RFC-0023](0023-background-subagent-lifecycle.md) 与 RFC-0025 的执行归属继续有效。

科研工作往往跨越许多模型轮次和实验：Agent 完成一次训练、回答进度问题或输出阶段总结，都不应导致整个研究任务自然终止。平面 Todo 也无法区分“训练结束”“实验分析完成”“假设得到验证”和“研究目标达成”。本设计让 Session 持有明确目标，由运行时持续安排有意义的下一步，并保留宏观判断与微观实验记录。

设计调查以 `9ed88359574de9f37355e4df0507a17824be32dd` 为基线。现有 V2 runner 在工具 continuation 或 inbox 有输入时继续，`SessionTodo` 则覆盖保存一组无稳定 item ID 的步骤；这些能力可复用，但不等同于 Goal。本文不将用户提供的 Session ID 当作故障复现证据，也不读取该生产 Session。

首版覆盖 V2 Session、Core/API 与 TUI：持久目标、三层计划、强制规划、自动续跑、默认无人值守、预算、停止、等待、证据验收、历史及同步兼容。科研实验是正式的工作单元类型，普通开发任务可使用通用工作单元。

非目标：保证研究成功、自动选择研究课题、集群执行调度、跨设备活跃接管、训练平台/Slurm 等专用适配器、GPU 资源预留、Web/Desktop 完整 Goal 面板、自动提高权限或修改共享环境。当前运行机制之外的后台守护和崩溃后无人值守重放不由“持久目标”隐式提供。

## 2. 维护者决策与产品默认值

| 决策         | 结论                                           | 约束                                                                  |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| 默认提问策略 | 已决定：无人值守，禁用 `Question`              | 必要的人类决策记为 blocker；不依赖它的工作继续；权限审批独立保留      |
| 未指定预算   | 已决定：没有隐藏的总时间、token 或实验次数上限 | 可由用户显式设置预算；现有权限、并发、provider 与基础设施限制仍然有效 |
| 冷恢复       | 已决定：恢复记录，用户显式 resume 后继续       | 无人值守冷恢复后续单独设计；重启不自动调用模型或重放工具              |

其余取舍由设计负责方确定：每个 Session 至多一个未终结 Goal；固定三层而非无限嵌套；完成必须有证据；负结果不会自动使 Goal 失败；Goal 本身不授权启动第二套执行器。

## 3. 目标、阶段与工作单元

### 3.1 身份和事实来源

层级固定为 `Goal -> Milestone -> WorkUnit -> Steps`。Steps 是工作单元内部的有序 Todo，不是可继续递归的第四级项目树。

| 对象      | 必要内容                                                                         | 完成语义                                       |
| --------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Goal      | 稳定 ID、Session、目标原文、成功条件、约束、预算、revision、状态                 | 成功条件逐项满足且完成检查通过                 |
| Milestone | 稳定 ID、研究问题/阶段目的、验收条件、依赖、状态、结论和证据                     | 阶段问题得到约定程度的回答，不要求所有假设成立 |
| WorkUnit  | 稳定 ID、所属阶段、`experiment` 或 `task` 类型、目的、步骤、依赖、执行状态、结果 | 操作和必要分析结束，结果已记录                 |
| Step      | 稳定 ID、内容、状态、证据引用                                                    | 该具体步骤被执行并核实，或有理由地取消         |

一个 Goal 可以有多个并行研究阶段和实验，依赖只能构成同一 Goal 内的 DAG，不能成环、跨 Goal 引用为硬依赖或产生无归属条目。模型同时只有一个本地执行焦点，其他工作通过已有授权的 Session 委派或已启动外部作业并行。切换焦点不改变其他实验状态。

阶段状态为 `planned / active / blocked / completed / abandoned`；工作单元为 `planned / running / waiting / blocked / completed / failed / cancelled`；步骤为 `pending / in_progress / completed / cancelled`。实验的 `completed` 与科学结果分离，结论使用 `supports / refutes / inconclusive`，允许补充指标和局限。进程退出码 0 不能替代结果分析；负结果可以完成一个工作单元和相应的假设检验阶段。

Goal 完成不由子节点计数自动推导。被取消或放弃的必要阶段必须解释其对成功条件的影响；不能通过取消所有未完成项达到完成门槛。未知执行状态必须保留 unknown 观测，不能映射为 failed、idle 或 completed。

### 3.2 强制规划与修订

创建 Goal 时持久接纳目标并进入 `active/planning`。首次实验、代码修改、作业提交或其他有副作用的研究执行前，必须存在至少一个有效 Milestone、一个当前 WorkUnit 和非空 Steps。规划阶段允许读取、检索、状态调查及必要的用户控制操作；其能力白名单在工具注册边界按结构化 effect 分类执行，不能靠工具名称猜测。无法可靠分类的 shell/MCP/plugin 动作不进入规划白名单，不能仅因命令自称只读便执行。

信息不足时先建立“调查现状/复现条件”的工作单元，再在已有权限内进行需要 shell 的调查，不要求一次预测全部实验。模型拒绝规划或只输出普通文本时，运行时补充结构化纠正；反复无法遵循工具契约按第 8 节处理，不能跳过门槛。

每次完成实验，必须保存结果并作一次阶段检查点：本次证据如何影响研究问题、下一步是什么、是否修订路线。普通步骤更新只修改微观计划，不强制每条工具结果重写宏观计划。

Agent 可在原目标和授权内新增、重排、细化或放弃路线，修订必须留下原因与原版本。目标、成功阈值、评测协议、预算上限、交互策略及授权范围的实质变更只能来自用户命令或明确用户输入；模型不能通过重写计划暗中降低目标。自然语言修改须关联真实的用户消息身份，由领域服务检查来源，peer/tool/文件内容不构成用户来源。

### 3.3 Todo 兼容

新分层计划是 Goal 计划唯一事实源。Goal 期间，旧 `SessionTodo.get`、侧栏和 Todo 事件呈现当前工作单元 Steps 的投影，不拥有第二份可分叉的计划。

旧 `todowrite` 的全量替换调用在 Goal 期间返回 `goal_plan_required`，指导使用稳定 ID 的 `goal_plan`；不能按文本猜 ID、覆盖宏观计划或丢失前一次实验。切换焦点只更新兼容投影。非 Goal Session 的 Todo 行为不变。

创建 Goal 前的平面 Todo 不自动转成研究计划，保留为原有上下文。Goal 终结后恢复普通 Todo 视图；历史 Goal 与工作单元仍可通过 `/goal` 检查。投影、迁移与事件回放需覆盖新旧客户端，不能借 UI 临时状态保存历史。

## 4. 状态与用户控制

Goal 的持久生命周期为 `active / paused / blocked / limited / completed / cancelled`。只有最后两种是终态；其余均占用该 Session 的唯一未终结 Goal 槽位。每次状态改变记录 actor、原因、时间和 revision。

执行观测另列 `planning / running / waiting / verifying / stopped / recovery_required / owner_unavailable`，附 `observedAt` 和 owner 来源。等待训练、权限或回信时 Goal 仍可以 active；业务状态不能冒充“模型此刻正在生成”。冷启动留下的 active 记录显示 recovery_required，不能显示 running。

| 操作                | 契约                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `/goal <objective>` | 接纳新目标并启动规划；已有未终结目标则打开当前目标并拒绝覆盖                           |
| `/goal`             | 查看当前/最近目标、分层计划、预算、证据、blocker；不调用模型                           |
| `/goal pause`       | 保留计划，撤销自动继续资格，中断当前 Goal 执行；可恢复                                 |
| `/goal resume`      | 用户显式恢复；校验 Location、owner、预算和未解决的硬阻塞，再核对检查点                 |
| `/goal cancel`      | 终结该目标并撤销自动继续资格；不删除实验记录或 Session                                 |
| `/goal edit`        | 在同一管理视图修改目标、条件、预算或交互策略；记录版本；不自动恢复 paused/limited 目标 |

用户明确自然语言“停止/继续这个目标”可由控制工具转入同一领域操作，必须关联该用户输入。重复操作幂等。接纳回执只表示保存成功，不承诺模型已经开始；执行未开始时 UI 展示原因。

配置的 Session 中断动作，包括既有双 Esc，在该 Session 有 active Goal 时同时暂停 Goal，**即使模型正在等待或暂时没有活跃 drain**。这是对 RFC-0025 §5 / §5.1 所述 idle no-op 的明确窄化修订：无 active Goal 的 idle Session 仍 no-op；暂停 Goal 的成功与打断某次 provider/tool 的成功分别报告。

暂停/取消先在串行领域边界持久撤销本地执行代际，再取消当前 provider/tool，并报告实际清理结果。迟到 timer、Question answer、permission reply、child result、队列 wake 或旧操作重试都不能恢复已撤销代际。若完成与停止竞争，先提交者决定结果；后者返回真实终态，不能倒退状态或命中新 Goal。

中断 Goal 不声称外部训练、独立 child Session 或云作业已被杀死。暂停后停止新增工作，按现有工具取消契约尽力中断受控调用；其他作业逐项显示继续运行/已停止/unknown。终结前对尚存 Goal-owned 工作明确等待、停止或移交；禁止静默遗留。取消 Goal 与删除 Session 是不同操作，删除仍遵循全局 tombstone 契约。

Goal-owned 委派继承目标执行代际：暂停/取消阻止这些工作的后继 provider 请求和新委派，并按准确 invocation 请求中断；不终止同一 child Session 后来接纳的独立工作。可解除 Goal 归属的移交必须由用户明确授权并指定接收范围，模型不能自行“移交”为无归属工作来逃避停止或预算。普通独立 child 和已脱离控制的外部作业不因此被当作已停止。

普通进度问题、补充信息或回答不会替换目标；active 时在安全边界处理后继续目标。paused/blocked/limited 时可以处理用户当前明确请求，但不能自动重启旧目标；恢复必须明确。用户可以在查看 blocker 后直接发送恢复指令，无需再经过确认弹窗。

只有用户控制可以将 Goal 置为 paused；模型通过 blocker 表达无法推进，不能为了省事自行暂停。系统错误可以撤销执行资格并报告 blocked/limited/recovery_required，但不能冒充用户暂停。解除局部 blocker 可由可信结果或模型提交新证据；整个 Goal 已 blocked 后仍需用户明确 resume，不能由迟到事件自行恢复。

## 5. 自动续跑与现有执行契约

Goal 是 Session 的工作策略，不是第二个模型循环。`SessionExecution` 继续 process-global、按 Session ID 调度；runner、模型、工具、权限和文件系统保持 Location-scoped；一次 provider turn 仍只有一次 `llm.stream(request)`，每次 continuation 重读投影历史。

在现有自然完成边界，按以下顺序做领域判断：

1. 检查 Session 删除、用户停止、owner/Location 可执行性以及预算；不得为了输出告别语再越界调用模型。
2. 接纳/晋升应在本边界交付的用户 steer 和可信控制变更。
3. 处理本轮工具结算和结构化目标更新；失败或输出 final 都不直接等同 Goal 结束。
4. 完成条件已有有效申请则验证；存在可推进工作则准备下一次 Goal continuation。
5. 只有等待条件时登记等待；只有 blocker 时按第 8 节结算为 blocked；达成明确上限则 limited。

内部 continuation 是带 Goal ID、revision、执行代际和原因的系统工作记录，不能伪造用户消息，不能重用 `SessionV2.prompt` 注入“用户让你继续”。用户 prompt 仍先 durable admission 再 advisory wake，精确重试与 delivery mode 契约不变。advisory wake 扩展为可排空本进程有资格的 Goal continuation；不是任意 active 数据行都可以触发执行。

续跑记录与执行资格检查幂等，唯一键至少覆盖 Goal、触发边界和本地代际。重复投递最多启动一次后继工作；接纳与消费竞争由同一个 Session coordinator 串行解决。Goal completed/cancelled 后的旧 wake 只能被忽略。不能用周期性向 TUI 输入“继续”的方式实现。

### 队列与 step allowance

为了防止长 Goal 饿死显式 queue，**每次正常逻辑 turn 本应变为空闲的边界，先按现有规则晋升一个 queued input，再考虑自动 Goal continuation**。不能把全部 Goal 生命周期拼成一个永不空闲的逻辑 turn。工具 continuation 期间 steer/queue 语义保持原样；每次处理完一个 queued input 重新判断，不能无限批量晋升。Task-owned drain 仍只结算自己的 invocation，不把 Goal 终态写成 child 工作结果。

自动 continuation 不算新用户输入，不能通过伪 admission 重置 `agent.steps`。明确配置的 `agent.steps` 仍是有效限制；跨自动逻辑 turn 保留对应 allowance，耗尽时进入 limited，显示限制来源。真实新输入按既有契约重置 provider-turn allowance，但从不重置 Goal 总用量。Goal 自身默认不新加总 steps 限制；显式 resume 可以授予新的 turn allowance，不能清零累积预算。

## 6. Question 与授权边界

默认交互策略为 `unattended`。Goal-owned 执行的 tool advertisement 不包含 `question`，执行入口、兼容 API 与别名仍进行领域校验并返回稳定 `goal_question_disabled`，不能仅依赖模型不去调用。

该策略跟随 Goal 委派的工作，而非永久修改 Agent 定义或被联系 Session 的所有工作。Goal-owned child 不得代问用户；父不能通过发送消息、打开另一个 Session 或输出“请确认后我再继续”绕过禁用。已有独立任务的权限和交互策略不被覆盖；若它不能承接无人值守约束，则拒绝把需代问的工作委派给它。

遇到真正缺失的决定时记录 blocker：问题、受影响的 criterion/milestone/work unit、为什么不可安全推断、已经检查的证据、可行替代方案、解除条件。blocker 在 Goal 面板可见，独立工作继续。不得制造一个暂停所有工作的同步 Question 等待，也不得把普通实现选择或“是否继续”登记为硬阻塞。

允许用户在 Goal 设置中显式选择 `blocking-only`。此时 Question 只能关联已有 blocker，并附影响范围与替代方案；Goal 内的提问使用异步接纳/答复记录，复用 Question 展示但不让同步工具调用占住整个 drain。回答在安全边界交付，独立工作仍可继续；拒答、取消、迟到答复不构成同意。普通非 Goal Question 契约不变。运行时可以校验结构和状态，不能宣称能完全判定自然语言问题是否必要。

任何策略都不改变现有 Permission allow/ask/deny。需要审批时执行保持未授权，UI 显示 approval pending；其他安全工作可推进。没有独立工作则 active/waiting，不反复调用模型。Goal 不自动允许共享配置变更、扩大云资源、删除数据或使用新身份；拒绝审批后不能换工具绕过。用户已经明确授权的范围也不得被 Goal 额外缩窄成重复确认。

模型自身不能切换交互策略、恢复用户暂停的目标、增加预算或创建一个替代 Goal 来绕过约束。目标只由显式用户请求创建；自然语言识别无法确认是否请求开启 Goal 时，保留普通 Session 行为。

## 7. 预算与用量

未设置预算时，持续推进直到完成、用户停止、真实阻塞或现有平台/权限限制；面板明确显示“未设置 Goal 上限”。不得偷偷在若干轮后以“任务太久”结束，或因为接近限额便伪报完成。

首版支持可选 `max_tokens`、`max_elapsed_ms` 和 `max_experiments`，由用户设置正值。多个限制取最先达到者。GPU-hours、金额硬上限和 provider 剩余额度不是首版可执行预算，不通过估算声称已强制限额。

- **Token**：统计 Goal-owned provider 请求的输入与输出 token，包含重试、压缩和委派；cached input 属输入子集，不重复相加，reasoning 若已包含于 output 不再重复计数。每次请求按稳定 attempt ID 结算一次。provider 不提供准确用量则标记 unknown；设置 token 硬预算时停止新的预算消费并进入 limited/usage_unknown，不能将其视为 0。
- **时间**：从首次启动起累加 active 时间，包含训练等待和审批等待，排除 paused/blocked/limited 区间。用持久区间和单进程单调计时累计；受控退出先结算并关闭区间。崩溃可能留下自最后计时检查点起的未知区间：保留已知用量和 unknown，不将未知当作 0；设置时间上限时先 limited/accounting_unknown，只有用户明确核定这段用量或修订时间预算后才能 resume。未设置时间上限不因此阻止恢复，仍显示不确定性。需要绝对截止时间的用户可另设 `deadline_at`，包含所有等待和暂停且不因 resume 延后。
- **实验次数**：按新 experiment WorkUnit 首次启动原子计数；修改实质配置或重新启动一次训练建立新 attempt，并消费一次实验额度。只重新读取指标、观察同一作业不计新实验；不能借复用实验 ID 绕过额度。普通 task 不消费该额度，但不能把实际实验改名为 task 绕过。

实验额度在提交 intent 时预留；确认未产生提交副作用的失败可释放预留，outcome_unknown 继续占用。达到实验次数上限只禁止提交下一次实验，仍允许分析最后一次实验、评测、汇总和完成验证；只有剩余目标必须再开实验且没有其他可推进工作时才 limited。时间/token 限制仍独立约束这些后续调用。

计量属于 Goal，不属于一次 drain 或某个模型轮次。新输入、换模型、切 Agent、计划修订、压缩、重启和 resume 均不清零。委派请求在接纳时固定预算归属，同一 attempt 只归一个预算；联系独立既有任务不追溯挪用其开销，也不能把新 Goal 工作伪装成独立任务以逃避计量。没有预算归属能力的执行入口不能承接有硬预算的 Goal 委派。

有限 token 预算下，为并发调用原子预留已知输入与 provider 可限制的最大输出额度，不足则不发出请求。无法建立可靠上界的 provider 明确返回预算不支持，不假装提供严格限额。实际结算与预留偏差必须展示；已提交 provider 的计费无法追回。到时间/用量边界时阻止新调用并尽力中断受控执行，外部训练可能继续消耗 GPU，Goal 时间预算不承诺远程作业成本上限。

增加预算或解除限制需要用户明确操作；保存预算并不自动 resume。用户设置过低的新限额立即撤销新增工作资格；已有结果和用量保留。

## 8. 无进展、错误与等待

### 8.1 有意义的进展与阻塞

新证据、完成操作、验证某条路线不可行、检查点结论或已登记外部作业的实际推进都可构成进展。改写同一句总结、反复调用 get、无理由增删 Todo、重复同一个失败动作不算。

连续三次自然结束的自动 Goal 轮次没有上述进展时进入诊断流程，要求说明原因并尝试不同的可行策略；阈值是触发诊断，不是自动失败或隐藏总轮数预算。诊断后仍没有可执行路径、或连续三次违反规划/控制工具结构契约时，领域服务记录 `no_progress` / `protocol_failure` blocker 并停止空转。必须保存可检查的轮次及证据；不能仅因文件没有变动判断读文献或训练等待无进展。

模型可报告 blocker，领域服务检查受影响工作、解除条件、以及是否还有 ready 节点。存在 ready 工作不能将整个 Goal 标 blocked；用户必须决策的单一外部事实可以立即阻塞其全部依赖，不强迫反复做三次无效实验。算法不能证明科学上“没有其他路线”，UI 将其呈现为 Agent 的有据判断，用户可修订路线后恢复。

provider 传输错误沿用既有可重试性与有界退避，不叠加另一层无限重试。认证/配置错误、耗尽重试、不可执行 Location 或 unknown owner 必须停止相关执行并给出准确原因。单次训练 OOM、低指标或负结果优先触发分析与新实验，不能直接结束整个 Goal。

### 8.2 等待与实验身份

只有真实依赖时才登记 `goal_wait`，包含工作单元、条件/观察引用、下一检查时间和检查方法。支持现有 child 结果事件与本进程定时唤醒；等待不持续调用 provider。相同 wait ID 和执行代际只交付一次，用户输入可提前唤醒重新规划；未到期或无变化不得每次 UI 轮询都调用模型。

轮询外部作业默认最短间隔 60 秒，无变化时指数退避至 15 分钟；已知短任务可由用户或可信执行适配器给出更短间隔。若检测必须调用模型，每次仍计量，并保留下一检查时间；纯读取观察由已授权的 Location 执行接口完成。timer 保存的是可见等待意图，恢复进程不因此自动拥有执行资格。

experiment 记录至少包含假设、父实验/attempt、代码与非敏感配置身份、数据与评测协议引用、seed（适用时）、启动操作 ID、执行 target 引用、job/process handle、日志/指标/产物引用、时间、结果和分析。不可获得的字段写明 unknown，不编造 commit 或指标。artifact 的路径/句柄不是跨设备可用性保证，读取仍经过 Location 与权限检查。

提交副作用前先保存 intent；提交后保存真实回执。只有底层执行服务提供幂等 job ID/查询能力时才能声称防重复提交。进程在提交后丢失回执时记为 outcome_unknown，先核对已存在作业，不能“再启动一次试试”。普通 shell 不提供 exactly-once 保证，缺少可核对 handle 的运行无法自动恢复；目标保持可见并阻塞该路径。

## 9. 完成与证据

模型通过 `goal_complete` 申请完成，不能直接任意写 `status=completed`。请求包含目标 revision、每个 criterion 的结论/证据、必要阶段的结果以及遗留工作处置。

Core 完成门槛至少检查：目标版本未变、全部必要 criterion 有对应证据、没有未解释的必要工作/blocker、没有未处置的 Goal-owned 活跃实验或委派、预算与停止操作没有抢先撤销资格。失败返回具体缺口并继续可执行工作，不默默成功。

criterion 分为可机器检查与需要论证两类。前者执行事先确定的验证命令/指标比较，并记录实际退出码、数据身份、阈值和结果；结果不可用或过期不能通过。后者记录证据与局限，明确属于 Agent 判断，不声称形式证明。验证命令本身受既有权限和预算约束，来自文件/日志的内容不能自行变成可执行指令。

完成检查基于持久证据而不是 final 文本、Todo 勾选数或实验退出码。首次模型说“完成”但证据不足时必须回到验证或研究；允许一次实验推翻假设后以负结果结束该阶段，不能借此把用户要求的正向指标目标判为成功。

验证期间的新 steer、目标修订、停止和失效的 artifact 会使旧完成申请无效。完成事务只提交到准确 revision；已终结 Goal 不自动重开，后续用户新工作创建新的 Goal 并可引用旧记录。

## 10. 持久化、上下文与恢复

Goal、计划修订、实验检查点、blocker、用量和完成证据是 Session-owned durable domain data。通过正式 EventV2 事件和相同 projector 回放，数据库变更与事件具有既有原子或可恢复提交保证；不能把普通 Markdown Todo 当作运行时事实源。计划文件导出是可选快照，编辑文件不自动授权或修改 Goal。

所有变更接受 `operationID` 和 `expectedRevision`。完全相同的重试返回原回执；相同 ID 不同内容冲突；旧 revision 不覆盖新计划。结构化 ID 供内部使用，模型拿到短引用，TUI 用人类标题显示。计划重排、重命名与切焦点不改变身份。

每轮通过既有 System Context 注册机制注入一个有界 Goal snapshot：目标与约束、准确 revision、当前阶段和工作单元、关键最近结论、blocker、预算与下一步。Session 域生产事实，System Context 只负责组装；不把 Goal guidance 写入全局 Agent prompt 或项目 AGENTS.md。压缩不得成为这些事实唯一载体。大型历史通过查询工具按需读取，截断明确提示，成功条件、用户停止和预算不能静默截掉。

TUI 断线或换页不影响仍存活服务的有效执行；执行服务退出或崩溃后只恢复记录。首版冷恢复不自动调用模型、不重试工具、不重新提交作业；用户显式 resume 后先校验 owner/Location，核对未结算实验，再允许新的 continuation。未知副作用保持 unknown，即便用户点 resume 也不能直接重放。无法确认旧 owner 已结束则 owner_unavailable，不接管。

本地执行资格与 process epoch、Session 代际绑定，永不从 portable `active` 状态重建。暂停/恢复经过统一 Session owner；任何历史回放、查询、compaction、fork、sync hydration 或前端重连不能凭自身产生执行许可。

### 同步、分叉与删除

逻辑目标和研究记录参与 RFC-0010 的 Session event 同步；本地 lease、timer handle、进程存活观测、凭据和可执行权限不上传。job 的非敏感引用可保留为记录，但不能当作跨设备执行 handle；不得把环境变量或密钥嵌入命令/配置快照。数据导出遵守相同边界。

同步到另一个控制设备只恢复可见内容，不恢复运行。首版不提供跨设备活跃 Goal 接管；另一个设备上的 resume 在无法证明旧 owner 已停时拒绝。跨设备控制、实时停止传播和分布式预算不在本 RFC 的保证内，UI 必须明确执行所在控制端，不能将“本地停止”报告成跨设备已停止。

目标和层级身份以 Session 归属命名空间隔离。RFC-0010 冲突生成 sibling Session 时，重映射内部引用，继承记录不继承执行资格；相冲突的预算用量不能简单清零或相加冒充准确账本，标记待核对，有限预算恢复前必须解决。主动 fork 只复制截至 fork 边界的研究记录并将未终结 Goal 置为 paused，记录来源；外部作业仅为引用，绝不重复接管。

旧客户端遇到不支持的 Goal event 版本时保留未消费数据并显示升级需求，不跳过事件推进 cursor 或回退为可执行的无 Goal Session。实现必须在发布首个 Goal event 前建立旧版本能够执行的 manifest/协议版本拒绝门槛；不能依赖给旧程序新增一个它本来不认识的 capability 字段。若既有版本无法安全拒绝，先交付兼容门槛并要求升级，禁止直接启用可同步 Goal。迁移需 additive schema 与事件版本/manifest 兼容测试，迁移失败保留旧数据库，不宣称降级客户端能安全编辑新 Goal。版本升级属于共享同步配置变更，需在实际启用时由用户明确授权，RFC 接受不代替该授权。

Session 删除撤销 Goal 执行资格、取消本地等待并删除对应 projection；全局 tombstone 胜过任何迟到 Goal/实验事件，重放不得复活。取消 Goal 保留审计历史，删除 Session 才使用现有全局删除流程。artifact 及外部训练作业不因删除记录被隐式删除或终止。

## 11. 工具、API 与 TUI

模型工具建议稳定为以下职责，最终 schema 必须保持本 RFC 的权限和状态约束：

| 工具              | 职责                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `goal_get`        | 查询目标、计划、blocker、预算及按需历史，无执行副作用              |
| `goal_plan`       | 以稳定 ID 和 revision 更新阶段/工作单元/步骤、切焦点、记录修订原因 |
| `goal_checkpoint` | 保存实验证据与阶段判断、登记或解除 blocker；不能自行提升权限       |
| `goal_wait`       | 登记明确等待条件和下一观察边界，释放模型执行                       |
| `goal_complete`   | 申请完成并运行领域验证，不能跳过证据                               |

用户管理操作 create/edit/pause/resume/cancel 与模型计划工具分离，控制调用需可信用户来源。Core 统一实现，Schema/Protocol 定义共享类型，Server 路由，Client 生成，TUI 只呈现并发起领域命令。公共 Protocol/HttpApi 变更后从 `packages/client` 执行 `bun run generate`，legacy SDK 有相关变更再用既有脚本再生；禁止手改 generated 文件。Client runtime 不依赖 Core/Server。

TUI `/goal`、Ctrl+P、侧栏入口复用同一个工作流。侧栏简要展示目标、阶段、当前实验、状态、最近证据和预算；详情按宏观计划/当前实验/历史逐层展开。研究阶段用问题和结论表达，不显示虚假的研究完成百分比；训练 steps 等真实可观测量可显示百分比并注明来源与更新时间。

状态列固定右对齐，遵循 `ui-design-guidelines.md` 的符号和焦点规则，不使用 emoji。异步实验更新保留选中项和滚动位置。正常保存/暂停/恢复不增加确认；取消保留记录且可由新目标接续，不引入“是否继续下一步”的弹窗。阻塞详情提供原因、影响及解除入口，不能只显示 blocked。

V1 backend 首版明确不支持创建或执行 Goal；返回 typed unsupported，不偷偷切后端或桥接 legacy loop。已有 V1 和非 Goal Session 行为保持不变。没有完整 Goal 支持的 Web/Desktop/旧客户端不得对 Goal Session 发起可能绕过约束的执行；服务端用统一领域校验拒绝不支持的控制请求，不能只隐藏按钮。

## 12. 交付边界与风险

接受本 RFC 后，后续实现可按下列可独立验收的契约拆分；这不是第二份任务队列，本次不创建实现 issue 或开始代码开发：

1. **持久目标与分层计划契约**：Schema、迁移、事件/投影、CAS、Todo 适配、查询和生成客户端；在运行闭环交付前不能提供可启动的 Goal 入口。
2. **Goal 执行闭环**：强制规划、续跑、默认禁问、权限兼容、队列、暂停/恢复、预算、完成检查及最小 TUI 作为一项端到端交付；不能仅上线“持续调用模型”的开关。
3. **科研实验闭环**：实验身份、提交 intent/回执、等待唤醒、阶段检查点与真实实验验收；没有可靠 handle 的作业准确降级。
4. **完整同步与兼容资格验证**：双设备只读恢复、冲突/fork/删除和旧版本门槛。前述任何交付若启用可同步 Goal，必须已经通过相应同步门槛，不能把数据安全验证推迟到用户使用之后。

具体实施 issue 须按 workflow 达到 Ready，注明依赖与 RFC 节号、风险所需平台和验收。部分交付应保持不可启动或有明确能力门槛，不把未实现条款呈现为可用功能。不要借此重写 SessionRunner、建立新的 permission 系统或复制 Question/Todo 的事实来源。

主要风险包括：无预算时长期消耗、错误完成判断、无人值守错过必要决定、暂停竞态、重复训练、副作用不确定、预算缺失/重复计量、事件兼容及删除复活。各自通过明确 UI、证据门槛、blocker、代际撤销、intent/核对、准确 unknown、幂等账本与既有同步删除规则控制；不承诺模型永不误判或任意 shell exactly-once。

## 13. 验收与验证

### 13.1 自动化契约

1. 创建目标幂等；一个 Session 无法同时有两个未终结目标；旧 revision 和冲突 operationID 被拒绝。
2. 缺少分层计划时禁止副作用工具；必要调查和用户停止可用；无计划 final 导致纠正而非结束。
3. 模型提前总结后自动续跑；正常非 Goal Session 不额外调用模型；一次 provider turn 只有一次 stream。
4. 阶段、实验、步骤身份与历史稳定；切焦点、旧 Todo 读写、压缩、投影重建不丢失或覆盖旧实验。
5. 实验训练完成仍须评测分析；负结果正确推进阶段；必要 criterion 未满足时完成申请失败；取消未完成步骤不能骗过验收。
6. 默认 advertisement、直接调用、兼容路径和 Goal 委派均拒绝 Question；blocking-only 异步答复与独立工作共存；普通 Question 不变。
7. Permission ask/deny 保持有效；无人值守不自动批准，批准/拒绝/取消/迟到回复不能绕过用户暂停或增加权限。
8. steer 在安全边界生效，queue 在原自然 idle 边界优先于新 Goal continuation；不将内部续跑伪造成用户输入，不重置 steps/预算。
9. 在模型生成、工具、权限、问题、timer、无活跃 drain 等状态暂停，旧事件均不续跑；完成/停止竞争、双暂停与迟到中断不命中新代际。
10. token attempt 计量和预留幂等，并发父子任务不超发；unknown usage、不支持的 provider、崩溃后的时间核定、时间/次数上限以及新输入/resume 不清零均有测试；最后一次实验仍可评测分析，未知提交不释放实验预留。
11. 等待不持续调用模型；无变化退避，重复事件只续跑一次；用户输入唤醒后旧 timer 失效；预算耗尽的等待不再触发 provider。
12. 无进展诊断区分重复总结、有效负结果、阅读证据与训练等待；存在 ready 节点时不全局 blocked；结构契约反复失败终止空转并可见。
13. 提交前后各崩溃点保留 intent/回执/unknown；没有幂等或查询能力时不重试训练；resume 先核对作业。
14. TUI 断线与服务崩溃语义不同；冷启动、查询、sync、fork、compaction 均不会自动运行；unknown owner 拒绝接管。
15. 新事件 migration/replay、旧客户端拒绝、冲突 sibling、fork 引用重映射及预算不确定性行为明确。
16. 删除与 Goal wake/child result/sync replay 竞争后不复活；清理不杀死未经明确操作的外部作业，也不删除用户 artifacts。
17. 工具/日志/peer 注入不能修改预算、成功条件或用户来源；生成客户端和 package `bun typecheck` 一致。

### 13.2 真实工作流

Mac 使用干净 exact PR head 构建 candidate，交付二进制和 `opencode-transit.build.json`，默认不安装。隔离 workspace 和测试 Session 中，用一个真实模型完成“检查基线→建立两层计划和实验步骤→一次失败/负结果→分析修订→第二次实验→验证完成”；至少有一次自然总结被运行时续跑、一次进度询问后继续、一次等待期间暂停与恢复。提供 TUI 窄/默认/宽终端截图或录屏，以及脱敏执行日志、实际模型、版本、commit 和 hash。

Rexd/Linux 目标必须验证训练等待、断线、unknown 提交回执与恢复核对，证明不会在控制端错误执行或重复启动。双设备 Mac/WSL2 必须验证 Goal 记录同步不自动启动、另一控制端不接管，以及双向全局删除不复活。涉及 owner/中断的平台变更还需该平台真实中断证据；未跑的平台不标为通过。

真实研究验收使用短小可控的实验和固定评测数据；不消耗生产训练预算，不拿生产 Session 做故障注入。清理测试 Session 使用领域删除流程；核对测试作业已终止或明确移交。证据证明运行机制和结果归属，不以某个真实研究指标必然提升作为软件正确性要求。

本文档交付本身只检查格式、相对链接、RFC 元数据/索引、现有契约一致性和 diff 范围；不运行功能测试、构建或安装，不将文档验收冒充上述运行时验收。

# RFC Index

RFC（Request for Comments）用于记录本 fork 中影响多个模块或核心行为的设计决策。

新增或修订 RFC 时，遵循[设计宣言](../design-manifesto.zh.md)（[英文规范版](../design-manifesto.md)）及[开发工作流中的设计评审要求](../development-workflow.md#applying-the-design-manifesto)，在现有动机、契约和验收章节中说明适用的取舍。宣言指导长期方向；具体行为仍由已接受的 RFC 定义，不能把尚未实现的原则当作现有能力或操作授权。

| ID                                             | 标题                                   | 状态     |
| ---------------------------------------------- | -------------------------------------- | -------- |
| [0001](0001-shell-execution-scope.md)          | Execution Scope Model                  | Accepted |
| [0002](0002-rexd-remote-execution.md)          | Rexd Remote Execution                  | Accepted |
| [0003](0003-command-effects.md)                | Core Command Toolkit                   | Accepted |
| [0004](0004-user-shell-session.md)             | User Shell CWD Continuity              | Accepted |
| [0005](0005-location-environment.md)           | Location Environment Loading           | Accepted |
| [0006](0006-builtin-command-adjustments.md)    | Built-in Command Adjustments           | Accepted |
| [0007](0007-provider-usage.md)                 | Provider Usage Surfaces                | Accepted |
| [0008](0008-tui-input-interactions.md)         | TUI Input Interactions                 | Accepted |
| [0009](0009-session-location-rebinding.md)     | Session Target Recovery                | Accepted |
| [0010](0010-encrypted-session-sync.md)         | Multi-device Session Sync              | Accepted |
| [0011](0011-location-aware-model-context.md)   | Location-aware Model Context           | Accepted |
| [0012](0012-skill-catalog-and-invocation.md)   | Skill Catalog and Sync                 | Accepted |
| [0013](0013-opencode-transit-identity.md)      | OpenCode Transit Identity              | Accepted |
| [0014](0014-subagent-economics.md)             | Economics-aware Subagent Routing       | Accepted |
| [0016](0016-subagent-access-manager.md)        | Subagent Access and Definition Manager | Accepted |
| [0017](0017-agent-slash-commands.md)           | Agent Slash Commands                   | Accepted |
| [0019](0019-target-descriptions.md)            | Target Descriptions                    | Accepted |
| [0020](0020-model-context-inspection.md)       | Model Context Inspection               | Draft    |
| [0021](0021-location-execution-permissions.md) | Location-derived Execution Permissions | Draft    |

## 状态

- `Draft`：设计仍可修改，不应开始大规模实现。
- `Accepted`：设计已经确认，可以据此拆分实现任务。
- `Implemented`：验收条件已经满足。
- `Superseded`：已由另一篇 RFC 替代，原文保留作为历史记录。
- `Rejected`：未采用，原文保留作为决策记录。

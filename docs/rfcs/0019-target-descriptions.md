---
id: 0019
title: Target Descriptions
status: accepted
authors:
  - hammershock
created: 2026-09-19
updated: 2026-09-19
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/471
depends-on:
  - 0002
supersedes: []
superseded-by: []
---

# RFC-0019：Target Description

## 摘要

Target 增加可选的人类可读 `description`。用户可以在创建或编辑 Target 时设置描述，并通过现有 Target 查看与列表接口读取。描述随设备本地 Target registry 持久化；旧配置缺少该字段时继续直接读取，不需要迁移，也不因读取而重写。

本 RFC 从 Draft RFC-0017（[#464](https://github.com/hammershock/opencode-transit/issues/464)）中抽出最小、可独立验收的数据基础。它只定义描述字段的数据链和现有 UI，不接受 RFC-0017 的 Agent slash-command、`/target list` 或 environment guidance 设计。设计追踪见 [#468](https://github.com/hammershock/opencode-transit/issues/468)。

## 契约

`Target.Input` 与 `Target.Definition` 增加：

```text
description?: string
```

- `description` 是用户维护的用途说明。它不参与 Target ID、名称唯一性、连接、权限、健康状态或 revision 计算之外的特殊语义。
- registry 的 create、update、restore 和 legacy import 沿用现有完整 Target 编解码与 revision-conflict 规则并保留该字段。
- 缺失字段保持缺失。创建/编辑 UI 将空白输入规范为缺失值；非空输入去除首尾空白后保存，内部空白不另作语义解释。
- 现有 Target list、create、update、restore 和 import Protocol response 通过 `Definition` 自然返回该字段；不增加新 endpoint。
- 描述属于设备本地 registry，不进入 Session identity 或 Session sync。它不是指令、命令或授权，也不触发远端 I/O。

## 用户界面

Target 创建向导在名称之后提供可选 Description 输入。编辑时预填现值，清空后保存会移除字段。Target 管理列表在名称下展示非空描述，详情/编辑流程可读取并修改它。

描述是普通文本。当前 Feature 不把它注入模型上下文，也不新增终端控制字符处理或独立长度限制；现有 UI 文本渲染边界继续适用。

## 兼容与分层

该变化是 additive optional field：旧 `targets.jsonc` 无需迁移，旧调用方可继续省略字段。Schema 拥有公共 wire contract，Core registry/wizard 拥有持久化与 draft 转换，Protocol/Server 复用 Schema contract，TUI 只编辑和展示该数据。公开 Protocol 变化后必须从 `packages/client` 运行 `bun run generate`，不得直接编辑生成文件。

不改变 Rexd transport、远端目录检查/创建、Session Location、Target binding、健康探测或删除语义。

## 非目标

- Agent slash-command 工具或 command audience
- `/target list` 命令
- `$SKILL-environment` 或启动 environment guidance
- Subagent 的 target / Location
- 远程目录检查或创建

## 验收与验证

1. 创建和编辑 Target 时可以设置、修改和清空可选描述。
2. registry 重载后保留非空描述；旧配置继续读取且不需要迁移或读取时重写。
3. 现有 Target view/list API 以及 create/update response 返回描述。
4. TUI 管理列表展示非空描述，未设置时不出现空占位。
5. 描述不改变连接输入、权限、identity、Session sync 或远端行为。

实现使用独立 Issue、branch、worktree 和 PR。验证包含 registry/wizard 聚焦单元测试、Target HttpApi 测试、TUI wizard/manager 测试、生成客户端一致性与受影响包 typecheck。该改动范围窄、字段可选、无迁移及新权限边界，可在聚焦测试通过并打开 PR 后使用 focused fast path；合并后仍需从精确 `dev` 集成提交 clean build、事务安装并做相称 smoke test。TUI 可见变化提供截图；Windows/WSL2 与真实远端 target 对此平台无关、无 transport 行为变化的字段不作为必需证据。

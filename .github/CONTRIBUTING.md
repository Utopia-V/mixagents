# Contributing

## Issue 与 PR 编号

GitHub 的 `#N` 是本仓库唯一的事项编号；Issue 与 Pull Request 共用同一序列。不要
另建 `BUG-001`、`PR-003` 等人工流水号。

- 仓库内正文写 `Issue #6`、`PR #3`，上下文清楚时可直接写 `#6`。
- 跨仓库写 `Utopia-V/mixagents#6` 或使用完整链接。
- 使用 `Fixes #N`、`Closes #N` 关闭已解决事项，使用 `Refs #N` 建立普通关联，使用
  `Supersedes #N` 表示替代关系。

Issue 标题使用表单生成的 `[Bug][Codex]`、`[Bug][Pi]`、`[Proposal]`、
`[Provider][Codex]` 或 `[Question]` 前缀；PR 标题使用 `feat:`、`fix:`、
`docs:`、`test:`、`refactor:` 或 `chore:`。标题不重复写编号。

## 提交内容

请选择最接近的 [Issue Form](ISSUE_TEMPLATE)，并标明受影响的
`codex-deepseek-subagent`、`pi-dsh-mimic` 或仓库级文档。现有分类都不适用时可以提交
Blank Issue。PR 应说明可观察变化、关联事项、验证结果、明确未验证的范围和有意保持
不变的边界。

标签用于描述类型、平台、领域和证据状态，不替代 `#N`。提交者不需要先掌握完整标签
体系；维护者会在 triage 时补充。

不得提交 API key、token、完整请求头、未脱敏配置或无关私有材料。如果内容由 Agent
协助起草，请在提交前核对实际观察，并把推断、未运行项和未知项明确标出。安全边界见
[SECURITY.md](../SECURITY.md)。

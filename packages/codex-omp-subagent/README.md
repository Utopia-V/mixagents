[仓库索引](../../README.md) · [English](README.en.md)

# Codex OMP Subagent

让 Codex 主任务把复杂代码重构、全库探索、AST/LSP 辅助分析和长程执行任务委派给外部 **OMP (Oh My Pi)** coding harness，同时保留 Codex 原生 `spawn_agent` 的父子会话结构。

V2 的关键变化是：**OMP 不再由 `SubagentStart` Hook 在 child 启动前执行，而是由真正的 `omp_worker` Codex child 自己启动。** `omp_worker` 使用现代 Codex permission profile：文件系统继承内置 `:workspace` 边界，同时为 OMP 配置的云模型 provider 开启出站网络；不会为了联网退化成 `danger-full-access`。

---

## V2 架构

```text
Codex Parent
    │
    │ stage assignment
    ▼
UUID handoff envelope
    │
    │ spawn_agent(agent_type="omp_worker", fork_turns="none")
    ▼
Codex native child: omp_worker
    │  filesystem: :workspace
    │  network: full outbound, local binding disabled
    │
    │ python omp_bridge.py --mode run --handoff-id <UUID>
    ▼
OMP (Oh My Pi)
    │
    ├─ configured model/provider
    ├─ LSP / AST / search / shell
    └─ OMP internal subagents if configured
    │
    ▼
structured JSON result + local raw logs
    │
    ▼
omp_worker verifies workspace diff/tests
    │
    ▼
concise native Codex callback to Parent
```

### 为什么不再使用 SubagentStart Hook

V1 在 Hook 中直接 `subprocess.run("omp")`。这会让 Hook 本身承担长时间执行，而且 Hook 启动的外部进程并不等价于 spawned child 的命令执行边界。V2 把 OMP 执行移动到 `omp_worker` child 内部，使 OMP 成为真正由该 child 发起的 harness-level delegation。

---

## Handoff 协议

Bridge 有两个模式。

### 1. `stage`

从 stdin 读取完整 assignment，生成 schema 2 的 UUID handoff：

```bash
printf '%s' 'Refactor src/foo.py and run focused tests.' | \
  python3 "${CODEX_HOME:-$HOME/.codex}/hooks/codex-omp-subagent/omp_bridge.py" --mode stage
```

返回示例：

```json
{
  "staged": true,
  "schema": 2,
  "handoff_id": "...uuid...",
  "agent_type": "omp_worker",
  "state_root": "..."
}
```

每个 UUID 都有独立状态，因此可以同时存在多个 pending/running OMP 任务。

### 2. `run`

由 `omp_worker` child 调用：

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/hooks/codex-omp-subagent/omp_bridge.py" \
  --mode run \
  --handoff-id <UUID>
```

默认启动 OMP：

```bash
omp --print --mode json --no-session -- "<assignment>"
```

`--` 用于避免以 `-` 开头的 assignment 被 CLI 误解析为参数。`OMP_BIN` / `OMP_ARGS` 在 POSIX 使用 POSIX shell-word 规则解析，在 Windows 使用原生 `CommandLineToArgvW` 规则，避免 `C:\...` 路径被 POSIX `shlex` 破坏。

---

## 结果与日志

Bridge 不再把完整 OMP stdout/stderr 注入 Codex context。默认只返回有界结构化结果，包括：

- `status` / `exit_code`
- `stop_reason` / structured provider error
- OMP 最终摘要
- usage（若 JSONL `message_end` 提供）
- stderr 尾部
- job artifact 路径

Bridge 会识别 OMP JSON 模式中“进程 exit code 为 0，但 assistant `stopReason` 为 `error` / `aborted`”的情况，并把任务标记为失败。若最终大型 JSON record 截断，但之前已有完整 `message_end`，则保留可用的完整结果。

完整日志留在本地状态目录：

```text
<state-root>/
  pending/<uuid>.json
  running/<uuid>.json
  completed/<uuid>.json
  failed/<uuid>.json
  jobs/<uuid>/
    envelope.json
    omp.jsonl
    stderr.log
    result.json
```

### 默认 state root

默认使用 **system temporary directory**，而不是 `~/.local/state`。原因是 Codex 的 `:workspace` 权限允许 workspace roots 和系统临时目录写入，但不保证 spawned parent/child 可以写任意 home-state 目录。

- POSIX：`<system-temp>/codex-omp-subagent-<uid>`
- Windows：`<system-temp>/codex-omp-subagent`

目录在 POSIX 上按 `0700` 创建，任务文件按 `0600` 创建。需要持久保存日志时，可通过 `CODEX_OMP_HANDOFF_DIR` 指定其他目录，但该目录必须位于当前 Codex permission profile 允许写入的范围内。

---

## 安装

### 前置条件

1. 已安装支持 standalone custom subagent / `spawn_agent` 和 permission profile 的近期 Codex。
2. 已安装并配置 OMP，终端执行 `omp --version` 或 `omp` 正常。
3. OMP 内部使用哪个 provider/model 完全由 OMP 自己管理。

### 推荐：让 Codex 自动安装

把 [`prompts/install-with-codex.md`](prompts/install-with-codex.md) 复制给 Codex。

V2 安装内容：

```text
<codex-home>/agents/omp-worker.toml
<codex-home>/skills/use-omp-worker/
<codex-home>/hooks/codex-omp-subagent/omp_bridge.py
```

**V2 不需要注册 `SubagentStart` Hook。** 如果机器上安装过 V1，应删除 active `hooks.json` 中 matcher 为 `^omp_worker$` 的旧 OMP Hook，避免一个任务被重复执行。

`omp-worker.toml` 使用：

```toml
default_permissions = "omp-network-workspace"

[permissions.omp-network-workspace]
extends = ":workspace"
network = { mode = "full", allow_local_binding = false }
```

也就是说：工作区内允许 OMP 执行代码修改，同时允许访问用户自己在 OMP 中配置的外部 provider；不会自动获得 workspace 外写权限，也不会允许 OMP 打开本地监听端口。管理员/组织级 Codex requirements 仍可进一步收紧这些权限。

---

## 使用

Parent 应按照 `$use-omp-worker`：

1. 组织自包含 assignment；
2. 调用 bridge `--mode stage`；
3. 获取 `handoff_id`；
4. `spawn_agent(agent_type="omp_worker", fork_turns="none")`，message 中包含该 UUID 和验证要求；
5. 等待 native callback；
6. Parent 再决定是否接受、继续修改或执行更高层验证。

推荐的 spawn message：

```text
Execute staged OMP handoff <UUID>. Inspect and verify the resulting workspace changes, then report a concise result to the parent.
```

---

## 配置

- `OMP_BIN`: OMP executable/command prefix，默认 `omp`
- `OMP_ARGS`: 覆盖默认 OMP CLI 参数；不设置时使用 `--print --mode json --no-session`
- `OMP_TIMEOUT`: OMP run 超时秒数，默认 600
- `CODEX_OMP_HANDOFF_DIR`: 覆盖本地 handoff/job 状态目录

Bridge 还支持 `--timeout-seconds` 和 `--ttl-seconds`。

---

## 并发与幂等

V2 不再使用单一 `omp_worker.pending.json`，每个任务都有自己的 UUID 文件，因此不同 OMP worker 可以并行处理不同 handoff。

同一个 UUID 完成后再次调用 `--mode run` 不会再次启动 OMP，而是返回已保存的 `result.json`。这避免 callback/retry 导致重复修改代码。

---

## 测试

离线测试不会调用真实 provider：

```bash
python -m unittest packages/codex-omp-subagent/tests/test_omp_bridge.py -v
python packages/codex-omp-subagent/tests/test_agent_templates.py
```

当前测试覆盖：

- 多 pending UUID handoff
- 真实形状的 OMP `message_end` / nested usage 解析
- provider structured error 即使 exit 0 也判定失败
- truncated terminal JSON 容错
- `--print --mode json --no-session --` 参数约定
- completed handoff 幂等
- 非法 UUID
- agent permission profile / V2 执行契约
- Ubuntu / Windows，Python 3.11 / 3.13 CI

真实端到端验证见 [`prompts/quick-smoke-test.md`](prompts/quick-smoke-test.md)。真实 smoke test 会使用你在 OMP 中配置的 provider，可能产生对应费用。

---

## 安全边界

V2 不使用 `danger-full-access`。`omp_worker` 的 permission profile 继承 `:workspace` 文件系统边界，只额外开放 OMP 所必需的出站网络，并禁用 local binding。

OMP 自身仍是一个完整 coding harness，能够在 child 允许的工作区范围内调用工具、运行命令和修改代码。不要把包含敏感数据的任务发送给不受信任的第三方 provider；如果组织级策略禁止网络或自定义 permission profile，应以组织策略为准并让 smoke test 明确失败，而不是绕过策略。

本项目是独立社区集成，与 OpenAI 或 OMP 均无官方隶属或背书关系。

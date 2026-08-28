[仓库索引](../../README.md) · [English](README.en.md)

# Codex OMP Subagent

让 Codex 主任务能够将复杂的代码重构、全库探索和长程执行任务无缝委派给外部的 **OMP (Oh My Pi)** coding harness 作为子代理 (Subagent) 执行。

OMP 内部所使用的底层模型（如 Gemini 3.7 Flash、Claude、DeepSeek 等）及工具箱完全由 OMP 自身环境进行配置，Codex 主会话通过 `omp_worker` 桥接层与 OMP 进程进行任务派发与结果接收。

---

## 架构与工作流程

1. **Parent 任务分派**：Codex 主 Agent 按照 `$use-omp-worker` 规范将自包含 assignment 写入本地状态（Stage）。
2. **Hook 拦截与执行**：Codex `SubagentStart` Hook 触发 `omp_bridge.py`，以非交互模式在当前工作区启动 `omp` 进程。
3. **输出与结果中继**：Bridge 脚本捕获 OMP 的执行日志、输出及变更，作为 `additionalContext` 注入给 `omp_worker` 子会话。
4. **Callback 整合**：子会话将执行结论与证据回传给 Codex 主会话。

---

## 安装与配置

### 1. 确保系统已安装并配置好 OMP
在终端测试 `omp --version` 或直接运行 `omp` 可正常工作，并在 OMP 中配置好你期望使用的模型（例如 Gemini 3.7 Flash）。

可通过环境变量自定义 OMP 行为（可选）：
- `OMP_BIN`: 指定 OMP 可执行文件路径（默认 `omp`）
- `OMP_ARGS`: 额外的 CLI 参数
- `OMP_TIMEOUT`: 进程超时秒数（默认 600）

### 2. 通过 Codex 自动安装
将 [`prompts/install-with-codex.md`](prompts/install-with-codex.md) 的内容复制给 Codex 执行。

### 3. 信任 Hook 并测试
1. 在 Codex 中输入 `/hooks`，信任新注册的 `omp_worker` hook。
2. 新建任务并执行 [`prompts/quick-smoke-test.md`](prompts/quick-smoke-test.md) 验证连通性。

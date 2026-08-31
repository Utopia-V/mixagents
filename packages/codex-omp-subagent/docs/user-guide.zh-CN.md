[返回组件 README](../README.md) · [返回仓库首页](../../../README.md)

# Codex OMP Subagent V2 完整使用指南

本文面向已经使用 Codex CLI、并希望把复杂代码任务委派给 **OMP (Oh My Pi)** 的用户。它重点回答三个问题：

1. 如何安装并确认 OMP V2 已经被 Codex 正确识别；
2. 日常在 Codex 中应该怎样调用 `$use-omp-worker`；
3. 出现权限、provider、PATH、超时或 handoff 问题时怎样定位。

如果只想了解 V2 的 bridge 协议、permission profile 和实现原理，请阅读组件 [README](../README.md)。

---

## 1. 一句话理解它在做什么

Codex 仍然是父 Agent 和最终编排器；OMP 是一个外部 coding harness。用户不需要在每次任务中手工调用 `omp_bridge.py`，而是让 Codex 使用 `$use-omp-worker`：

```text
Codex Parent
    ↓
$use-omp-worker 组织任务并 stage
    ↓
schema-2 UUID handoff
    ↓
spawn_agent(agent_type="omp_worker", fork_turns="none")
    ↓
Codex native child: omp_worker
    ↓
child 调用 omp_bridge.py --mode run
    ↓
OMP + 用户已经配置的 provider/model
    ↓
代码修改 / 搜索 / AST / LSP / 测试
    ↓
omp_worker 检查 diff 与验证结果
    ↓
Codex Parent 收到 concise callback
```

V2 的核心原则是：**OMP 由真正的 `omp_worker` child 启动，而不是由 `SubagentStart` Hook 代替 child 执行。**

---

## 2. 什么时候适合使用 OMP Worker

推荐把 OMP Worker 用在明显受益于 coding harness 的任务上，例如：

- 全仓库结构探索、跨模块依赖分析；
- 多文件重构、接口迁移、配置系统重构；
- 需要 AST/LSP 辅助定位的代码修改；
- 比较复杂的 bug 定位与修复；
- “分析 → 修改 → 跑测试 → 检查 diff”这一类长链路工程任务；
- 需要 OMP 自己进一步使用工具或内部 subagents 的任务。

不建议为了很小的改动强制经过 OMP，例如：

- 修改 README 中一句话；
- 改一个常量或配置值；
- 明确知道位置的单行修复；
- Codex Parent 自己几步就能完成的局部任务。

一个实用的判断规则是：**如果主要困难来自代码库探索、多工具协同或长程执行，而不只是生成几行代码，就值得考虑 OMP Worker。**

---

## 3. 前置条件

正式使用前应满足：

1. 已安装近期 Codex CLI，并支持 standalone custom subagent、`spawn_agent` 和 permission profile；
2. Codex 自己能够正常启动并写入其 `CODEX_HOME`；
3. 已安装 OMP，并且在普通终端中能够执行：

```bash
omp --version
```

或直接：

```bash
omp
```

4. OMP 内部已经配置好你实际想使用的 provider/model；
5. 当前仓库已经安装本项目的 OMP V2 组件。

OMP 的 provider/model 配置独立于 Codex。本项目不会替你修改 OMP 的模型选择，也不会改变 Codex Parent 当前使用的 OpenAI 模型、登录状态或 provider 配置。

---

## 4. 安装

### 4.1 推荐方式：让 Codex 自动安装

克隆或更新本仓库：

```bash
git clone https://github.com/feiyushaw/mixagents.git
cd mixagents
```

如果已经存在本地仓库：

```bash
git pull
```

然后把下面文件中的安装 prompt 复制给 Codex：

```text
packages/codex-omp-subagent/prompts/install-with-codex.md
```

安装器应把组件放到当前 `CODEX_HOME` 下：

```text
<codex-home>/agents/omp-worker.toml
<codex-home>/skills/use-omp-worker/
<codex-home>/hooks/codex-omp-subagent/omp_bridge.py
```

并把项目提供的 routing snippet 合并到个人 `AGENTS.md`（如果存在对应入口），同时避免重复添加。

### 4.2 V1 用户升级注意

V2 **不需要** `SubagentStart` Hook。

如果机器上以前装过 V1，应确认 active `hooks.json` 中不存在 matcher 为：

```text
^omp_worker$
```

的旧 OMP `SubagentStart` 项。安装 prompt 会要求 Codex 只删除这一条遗留 OMP hook，不影响其他 hook。

### 4.3 安装后快速检查

POSIX/macOS/Linux：

```bash
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"

ls "$CODEX_ROOT/agents/omp-worker.toml"
ls "$CODEX_ROOT/skills/use-omp-worker/SKILL.md"
ls "$CODEX_ROOT/hooks/codex-omp-subagent/omp_bridge.py"

python3 "$CODEX_ROOT/hooks/codex-omp-subagent/omp_bridge.py" --help
```

Windows PowerShell：

```powershell
$root = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }

Get-Item (Join-Path $root 'agents/omp-worker.toml')
Get-Item (Join-Path $root 'skills/use-omp-worker/SKILL.md')
Get-Item (Join-Path $root 'hooks/codex-omp-subagent/omp_bridge.py')

python (Join-Path $root 'hooks/codex-omp-subagent/omp_bridge.py') --help
```

如果刚完成安装，建议**新开一个 Codex session**，确保 custom agent 和 skill 被重新加载。

---

## 5. 第一次正式使用前的检查

### 5.1 确认没有残留 mock OMP

如果此前做过本项目的零付费 E2E 测试，可能设置过：

```bash
export OMP_BIN="python3 /tmp/mock_omp.py"
```

正式使用前应恢复默认：

```bash
unset OMP_BIN
unset OMP_ARGS
```

然后确认：

```bash
omp --version
```

否则 Codex 可能仍在调用测试 mock，而不是真实 OMP。

### 5.2 确认 OMP 自己能够调用真实 provider

建议先在普通 shell 中独立验证 OMP。provider/model 的认证、模型名称和费用均由 OMP 自己管理。

如果 OMP 自己不能完成请求，Codex OMP Subagent 也无法绕过该问题。

### 5.3 可选：跑一次真实 smoke test

仓库提供：

```text
packages/codex-omp-subagent/prompts/quick-smoke-test.md
```

把其中 prompt 复制到一个新的 Codex session。它会验证：

- schema-2 stage；
- native `omp_worker` spawn；
- child 内执行 bridge；
- OMP 返回；
- callback 回到 Parent；
- job artifacts；
- completed UUID 幂等性。

注意：这一步会使用你在 OMP 中配置的真实 provider，可能产生费用。

---

## 6. 日常使用：最推荐的调用方式

日常不需要自己操作 UUID。直接要求 Codex 使用 `$use-omp-worker`。

### 6.1 只读分析

```text
Use $use-omp-worker to inspect this repository.
Do not modify files.
Identify the main modules, their responsibilities, the important dependency boundaries,
and the highest-risk coupling points. Return a concise architecture summary with file evidence.
```

中文也可以：

```text
使用 $use-omp-worker 分析当前仓库，不要修改文件。
梳理核心模块、依赖边界、关键入口和耦合最严重的位置，并给出对应文件依据。
最后只返回精简结论。
```

### 6.2 跨文件重构

```text
Use $use-omp-worker to refactor the duplicated configuration-loading logic in this repository.

Requirements:
- preserve public behavior;
- avoid unrelated formatting changes;
- update all affected call sites;
- run the focused tests;
- inspect git diff before reporting;
- report changed files, validation performed, and remaining risks.
```

### 6.3 Bug 定位与修复

```text
使用 $use-omp-worker 调查并修复这个问题：<粘贴错误或现象>。

要求：
- 先定位根因，不要只处理表面报错；
- 只修改与根因有关的代码；
- 增加或更新能够覆盖该问题的测试；
- 运行相关测试；
- 最后说明根因、修改文件、验证结果和仍未解决的问题。
```

### 6.4 先分析、后决定是否修改

```text
Use $use-omp-worker to investigate <problem>.
Do not edit anything in the first pass.
Return the root cause, affected files, and a minimal implementation plan.
```

这种写法适合高风险仓库，因为 Parent 可以先审核 OMP 的分析，再发第二个 handoff 做修改。

### 6.5 代码审查

```text
使用 $use-omp-worker 审查当前分支相对 main 的改动。
重点检查：正确性、回归风险、异常路径、测试缺口和不必要的复杂度。
不要修改文件。按严重程度给出发现，并引用具体文件/符号。
```

---

## 7. 怎样写一个适合 OMP 的任务

`omp_worker` 使用 `fork_turns="none"`，所以不要依赖 child 自动继承 Parent 的完整历史。Parent 会先把任务写成 self-contained assignment 再 stage。

一个高质量任务最好包含：

- **目标**：到底要解决什么；
- **范围**：仓库、目录、文件、模块或符号；
- **约束**：哪些行为不能改变、哪些文件不要碰；
- **验收标准**：什么算完成；
- **验证方式**：要跑哪些测试/命令；
- **输出要求**：最后希望 Parent 收到什么信息。

推荐结构：

```text
目标：
<具体目标>

范围：
<目录 / 模块 / 文件 / 符号>

约束：
- <约束 1>
- <约束 2>

验收标准：
- <可检查标准 1>
- <可检查标准 2>

验证：
- <测试或检查命令>

最终报告：
- 根因或设计判断
- 修改文件
- 测试结果
- 剩余风险
```

如果只是说“帮我优化一下整个项目”，OMP 当然也可以探索，但任务边界、成本和修改范围会更难控制。

---

## 8. Parent 与 OMP Worker 的职责边界

建议把职责理解为：

### Codex Parent

负责：

- 理解用户真实目标；
- 决定是否值得调用 OMP；
- 形成 self-contained assignment；
- 定义约束和 acceptance criteria；
- stage handoff；
- spawn/wait native child；
- 审核 callback 和最终结果；
- 决定是否继续修改、回滚或进行更高层验证。

### `omp_worker` child

负责：

- 根据 UUID 执行对应 handoff；
- 从 child 内部调用 bridge；
- 等待 OMP 执行；
- 查看 workspace 状态和 diff；
- 在可行时验证 acceptance criteria；
- 把关键结果简洁返回 Parent。

### OMP

负责实际 coding-harness 工作，例如：

- 搜索代码；
- LSP/AST 辅助分析；
- 调用 shell；
- 修改文件；
- 运行测试；
- 在 OMP 配置允许时使用自己的内部 subagents。

---

## 9. 配置项

Bridge 支持以下环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMP_BIN` | `omp` | OMP executable 或 command prefix |
| `OMP_ARGS` | `--print --mode json --no-session` | 覆盖默认 OMP CLI 参数 |
| `OMP_TIMEOUT` | `600` 秒 | 单次 OMP run 超时 |
| `CODEX_OMP_HANDOFF_DIR` | system temp 下的专用目录 | 覆盖 handoff/job 状态目录 |

Bridge CLI 另外支持 `--timeout-seconds` 和 `--ttl-seconds`。

### 9.1 `OMP_BIN`

常见用途是 OMP 不在 Codex 继承到的 PATH 中，或者测试时需要使用 wrapper：

```bash
export OMP_BIN="/absolute/path/to/omp"
```

测试完 wrapper/mock 后记得：

```bash
unset OMP_BIN
```

### 9.2 `OMP_ARGS`

一般不要设置。默认参数已经满足 V2 所需的非交互 JSONL contract：

```text
--print --mode json --no-session --
```

只有明确知道 OMP CLI 行为时才覆盖。

### 9.3 `OMP_TIMEOUT`

复杂仓库任务超过 10 分钟时可以提高，例如：

```bash
export OMP_TIMEOUT=1800
```

如果任务本身应当很短，却频繁超时，更应该先检查 provider、网络、死循环或任务范围，而不是无限提高 timeout。

### 9.4 `CODEX_OMP_HANDOFF_DIR`

默认不需要设置。V2 使用 system temp 是为了让 Parent/child 在 `:workspace` permission 边界下拥有可写的协调目录。

只有确实需要持久保存 handoff/log 时才覆盖，并确保目标路径属于 Codex 当前 permission profile 的 writable roots。

---

## 10. Permission profile 与安全边界

安装的 `omp-worker.toml` 使用：

```toml
default_permissions = "omp-network-workspace"

[permissions.omp-network-workspace]
extends = ":workspace"
network = { mode = "full", allow_local_binding = false }
```

含义是：

- 文件系统权限继承 Codex 内置 `:workspace`；
- OMP 可以访问其云 provider 所需的出站网络；
- 不允许本地 listener binding；
- 本项目不会把 child 配成 `danger-full-access`。

需要特别区分：

- OMP 是完整 coding harness，因此在 **child 被允许的 workspace 范围内**可以执行命令和修改代码；
- provider 可能是第三方服务，因此任务内容可能被发送给用户自己配置的第三方 provider；
- 不应把秘密、凭据或不适合外发的数据交给不受信任 provider；
- 组织/管理员级 Codex policy 可以进一步限制网络或文件系统，本组件不应绕过它。

---

## 11. Handoff、日志与本地状态

每次 stage 都会创建独立 UUID。状态大致为：

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

其中：

- `envelope.json`：原始任务 envelope；
- `omp.jsonl`：OMP structured output 原始记录；
- `stderr.log`：OMP stderr；
- `result.json`：bridge 返回给 child 的有界结构化结果。

Parent/child 默认不应把完整 `omp.jsonl` 塞回对话 context。需要排障时再查看对应 job artifacts。

### 默认 state root

- POSIX：`<system-temp>/codex-omp-subagent-<uid>`；
- Windows：`<system-temp>/codex-omp-subagent`。

POSIX 下目录按 `0700` 创建，任务文件按 `0600` 创建。

---

## 12. 并发与幂等性

不同 UUID 可以同时 pending/running，因此 V2 在协议层支持多个独立 OMP handoff。

但要注意：**协议支持并发，不等于多个写任务适合同时修改同一个 checkout。**

如果两个 OMP worker 同时修改相同文件，仍然可能发生正常的 Git/workspace 竞争。对真正的并行写任务，建议未来结合独立 git worktree 或明确拆分互不重叠的目录。

### 同一个 UUID 的幂等性

一个 handoff 完成后，再次执行：

```text
--mode run --handoff-id <same-uuid>
```

不会再次启动 OMP，而是直接读取保存的 `result.json`。

如果你确实需要重新运行相同逻辑，应让 Parent **重新 stage，生成新的 UUID**。

---

## 13. 更新组件

仓库升级后，推荐流程是：

```bash
cd mixagents
git checkout main
git pull
```

然后重新把：

```text
packages/codex-omp-subagent/prompts/install-with-codex.md
```

交给 Codex。

安装 prompt 的目标是更新 OMP agent、skill、bridge 和 routing snippet，同时保留无关的个人 Codex 配置。

更新后建议新开 Codex session。

---

## 14. 卸载

如果不再使用该组件，可以从当前 `CODEX_HOME` 移除以下内容：

```text
agents/omp-worker.toml
skills/use-omp-worker/
hooks/codex-omp-subagent/
```

并从个人 `AGENTS.md` 删除本项目安装的 OMP routing snippet。

如果曾经从 V1 升级，还可以再次确认 `hooks.json` 中没有遗留 matcher `^omp_worker$` 的 OMP Hook。

删除前如果你需要保留历史运行证据，请先备份 `CODEX_OMP_HANDOFF_DIR` 或 system temp 中对应的 job artifacts。

---

## 15. 常见问题与排障

### 15.1 Codex 提示找不到 `$use-omp-worker`

检查：

```bash
ls "${CODEX_HOME:-$HOME/.codex}/skills/use-omp-worker/SKILL.md"
```

如果文件存在但当前 session 仍不可见，退出并重新启动 Codex，让 skill 重新加载。

### 15.2 `agent_type="omp_worker"` 无法 spawn

检查：

```bash
ls "${CODEX_HOME:-$HOME/.codex}/agents/omp-worker.toml"
```

然后新开 Codex session。若 Codex 版本不识别 standalone agent 或 `default_permissions`，请升级 Codex，不要把配置改成 `danger-full-access` 来绕过兼容问题。

### 15.3 `omp: command not found`

先在启动 Codex 的同一个 shell 检查：

```bash
which omp
omp --version
```

如果 OMP 使用非标准安装路径，可设置绝对路径：

```bash
export OMP_BIN="/absolute/path/to/omp"
```

然后从这个 shell 启动新的 Codex session。

### 15.4 明明想调用真实 OMP，却一直得到 `OMP_READY_12345`

很可能保留了 E2E mock：

```bash
unset OMP_BIN
unset OMP_ARGS
```

再执行：

```bash
omp --version
```

### 15.5 provider 报错，但 OMP 进程 exit code 是 0

这是 bridge 已考虑的情况。它会检查 structured JSONL 中的 `stopReason` / provider error；如果 assistant 状态为 `error` 或 `aborted`，任务仍会进入 failed，而不是因为 shell exit 0 被误判成功。

排障时查看对应：

```text
jobs/<uuid>/result.json
jobs/<uuid>/omp.jsonl
jobs/<uuid>/stderr.log
```

重点检查 provider 的 structured error，而不只看进程退出码。

### 15.6 OMP 超时

临时提高：

```bash
export OMP_TIMEOUT=1800
```

同时检查：

- provider 是否响应；
- 网络是否可达；
- 任务范围是否过大；
- OMP 是否卡在测试/命令；
- 是否应该把任务拆成“分析”和“修改”两个 handoff。

### 15.7 `CODEX_OMP_HANDOFF_DIR` 无法写入

优先删除自定义值，回到 system temp：

```bash
unset CODEX_OMP_HANDOFF_DIR
```

如果必须持久化，请选择 Codex permission profile 明确允许写入的位置。

### 15.8 Codex 自己无法写 `~/.codex/state_*.sqlite`

这通常发生在**从一个已经受限的 Codex session 内再次嵌套启动 Codex CLI**，外层 sandbox 没有给新的 Codex 进程写 `~/.codex` 的权限。

不要把这个问题误判为 OMP bridge 故障。推荐：

1. 退出当前受限/嵌套 Codex；
2. 在普通 Terminal/iTerm/PowerShell 中启动新的 Codex；
3. 确认该 shell 对当前 `CODEX_HOME` 有正常写权限；
4. 再运行 native-child smoke 或真实任务。

Codex 也支持用 `CODEX_HOME` 指向其他有效目录，但该目录必须已存在并且当前用户可读写；不要为了测试随意复制一套不完整配置。

### 15.9 Python 3.9 可以跑 bridge，但 TOML validator 报 `tomllib` 缺失

当前 bridge 本身和 bridge unit tests 可以在旧 Python 环境运行；仓库的 standalone agent TOML validator 使用 Python 3.11+ 标准库 `tomllib`。

因此 Python 3.9 环境可能出现：

- bridge syntax/help/tests：通过；
- `test_agent_templates.py`：因为缺少 `tomllib` 无法执行。

这属于 validator 的开发环境兼容问题，不等同于 OMP V2 runtime 失败。CI 目前在 Python 3.11/3.13 上验证 agent TOML。

### 15.10 Windows 路径包含反斜杠时 OMP 参数被破坏

V2 已经针对 Windows 使用原生 `CommandLineToArgvW` 解析 `OMP_BIN` / `OMP_ARGS`，而不是用 POSIX `shlex` 处理 `C:\...`。

如果仍遇到问题，先记录实际 `OMP_BIN`、`OMP_ARGS` 和 bridge result，再检查 wrapper 命令本身的 Windows quoting。

### 15.11 同一个任务为什么第二次没有重新调用 OMP

因为你复用了已经完成的 UUID。这是设计好的幂等行为。

需要重新执行时重新 stage，使用新 UUID。

### 15.12 OMP 修改了不希望修改的文件

首先让 Parent 检查：

```bash
git status --short
git diff
```

不要在不检查的情况下直接接受结果。后续任务中应缩小 assignment 范围并明确写出“不要修改”的路径或行为。

---

## 16. 推荐的真实工作流

对于重要代码修改，建议使用“两阶段”方式，而不是一次把所有权交给 OMP。

### 阶段 A：调查

```text
使用 $use-omp-worker 调查 <问题>，不要修改文件。
返回根因、影响范围、候选方案、风险和最小修改计划。
```

Parent 审核后再进入阶段 B。

### 阶段 B：实现

```text
使用 $use-omp-worker 按已确认方案实现修改。
只修改 <范围>。
运行 <测试>。
检查 git diff。
最终返回修改文件、验证证据和剩余风险。
```

这种模式特别适合：

- 大型仓库；
- 高风险核心模块；
- 不熟悉的第三方代码；
- 需要严格控制变更范围的项目。

---

## 17. 当前验证状态

V2 baseline 已验证：

- bridge Python syntax / help；
- 7 个 bridge unit tests；
- agent permission contract；
- Ubuntu Python 3.11 / 3.13；
- Windows Python 3.11 / 3.13；
- 安装路径与 V1 hook migration；
- 真实 Codex runtime 中的 native-child E2E：

```text
spawn_agent
  -> omp_worker
  -> bridge run
  -> external mock OMP
  -> native callback
```

- job artifact 落盘；
- completed UUID 幂等；
- smoke 过程中 workspace 零污染。

真实 provider 是否可用最终取决于用户自己的 OMP/provider 配置，因此推荐首次正式使用前自行做一次低成本只读 smoke。

---

## 18. 当前没有做什么

V2 baseline 有意保持简单，目前不包含：

- persistent `omp --mode rpc` worker pool；
- 硬编码 Luna relay；
- 自动为多个并发写任务创建 git worktree；
- Python 3.9/3.10 的 standalone TOML validator fallback。

这些属于后续增强，不影响当前 one-shot OMP Worker 的日常使用。

---

## 19. 最短可复制模板

如果你已经完成安装和首次验证，日常最常用的模板可以缩短成：

```text
使用 $use-omp-worker 完成下面任务：

目标：<任务>
范围：<目录 / 模块>
约束：<不能改变的行为>
验证：<需要运行的测试>

完成后检查 git diff，并只汇报：
1. 做了什么；
2. 修改了哪些文件；
3. 验证结果；
4. 剩余风险。
```

对于只读分析：

```text
使用 $use-omp-worker 分析 <问题>。
不要修改文件。
给出有文件/符号依据的结论、根因和下一步建议。
```

这两种模板足以覆盖大部分日常使用场景。
[Repository Index](../../README.md) · [中文](README.md)

# Codex OMP Subagent

Enables Codex main tasks to delegate complex coding, AST refactoring, multi-tool analysis, and repository-wide explorations to the external **OMP (Oh My Pi)** coding harness as a subagent.

The underlying model (such as Gemini 3.7 Flash) and tools are configured inside your OMP installation. Codex acts as the parent session communicating via the `omp_worker` bridge.

---

## Workflow

1. **Stage Assignment**: Codex parent stages the self-contained task via `$use-omp-worker`.
2. **Hook Execution**: Codex `SubagentStart` hook triggers `omp_bridge.py`, executing `omp` in the workspace directory.
3. **Context Injection**: The bridge script captures OMP output and injects it as `additionalContext`.
4. **Callback & Integration**: The `omp_worker` subagent relays the synthesized findings back to the parent.

---

## Installation

1. Ensure `omp` CLI is accessible in your environment.
2. Provide [`prompts/install-with-codex.md`](prompts/install-with-codex.md) to Codex for automated installation.
3. Review and trust the Hook via `/hooks`, then run [`prompts/quick-smoke-test.md`](prompts/quick-smoke-test.md).

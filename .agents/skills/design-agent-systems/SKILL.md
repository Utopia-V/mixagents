---
name: design-agent-systems
description: 设计或审阅 Broker 等由 Model、Harness 与 Environment 共同产生行为的 Agent 系统。用于 context、长期状态、工具、MCP、权限、数据流与恢复语义。
---

# Design Agent Systems

当产品确实依赖模型形成判断或动作时，区分三个行为 owner：Model 形成候选判断与动作；Harness 构造观察、调用工具并维护运行状态；Environment 拥有事实、副作用与成功条件。

把状态、权限、恢复和验证放在实际拥有其语义的层。Prompt 不能成为环境事实的 owner，工具 schema 不能自行授予信任，summary 与索引不能替代长期权威，局部 eval 也不能替代产品父结果。

Broker 的 context、长期状态、工具、MCP、权限或持久副作用设计需要具体检查时，读取
[context-and-tools.md](references/context-and-tools.md)。

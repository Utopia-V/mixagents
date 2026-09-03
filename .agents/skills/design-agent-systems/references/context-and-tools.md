# Context、长期状态与工具

在具体问题涉及 context、memory、RAG、compaction、cache、tool、Extension、MCP、权限或持久副作用时读取本参考。它提供检查维度，不指定存储、检索、协议或 UI 方案。

## 信息清单

对每类会影响 Agent 行为的信息回答：

| 维度 | 问题 |
| --- | --- |
| 权威 owner | 哪个工件或主体拥有当前事实？谁可以修改？ |
| 依据性质 | 用户决定、项目规则、外部来源、环境观察、模型知识、推断还是摘要？ |
| 身份与版本 | 如何定位同一工件？更新、重命名、删除和冲突怎样识别？ |
| 工作视图 | 本轮为什么需要它，以何种表示进入 context，是否被截断或压缩？ |
| 失效 | 哪个版本、时间、权限或来源变化会让当前表示失效？ |
| 恢复 | compaction、重启或索引丢失后怎样回到权威事实？ |
| 数据去向 | 哪些内容留在本地，哪些会发送给 Model provider、工具或其他服务？ |

同一段文本可以同时出现在 Session、检索结果和 Prompt 中，但只有一个位置应拥有其长期语义。其余位置是索引、缓存、摘要或本轮视图。

## 工作视图的典型失真

- **权威倒置**：summary、索引或 cache 成为唯一副本，原始事实无法恢复。
- **来源坍缩**：来源材料、模型知识、用户判断和 Agent 推断在 context 中失去区别。
- **陈旧复用**：原工件已更新或删除，工作视图仍携带旧版本。
- **检索即真值**：命中结果未经版本、范围或内容核验便支撑回答。
- **无答案消失**：材料没有支持结论时，系统仍用模型知识补成带来源语气的答案。
- **压缩改义**：compaction 或摘要改变了未决事项、授权或否定条件。

设计不必让模型看到全部元数据，但 Harness 必须能维护必要身份，并在冲突、删除和恢复时产生正确行为。

## 稳定结构与 cache

稳定基础结构可以提高可理解性和复现性；Prompt Cache 是否带来收益是 provider、Model 和调用协议相关的观测事实。分开验证：

1. 语义上应稳定的内容是否真的稳定；
2. 动态状态是否留在正确的 owner 和更新位置；
3. provider usage、延迟和请求顺序是否显示可重复的缓存收益；
4. 工件版本变化后是否错误复用旧内容。

缓存命中不证明 context 正确，未命中也不自动证明架构错误。具体 TTL、计费、最小前缀和 cache key 只使用当前 provider 官方契约与真实观测。

## 工具的完整行动语义

对每类工具区分：

| 角色 | 需要明确的内容 |
| --- | --- |
| 提案者 | Model、用户、系统规则或其他服务为何提出动作？ |
| 授权者 | 谁允许哪个目标、数据范围、时间范围和副作用？ |
| 执行者 | 哪个 Host、进程、Extension 或远程服务实际行动？ |
| 副作用 owner | 文件、数据库、账号、外部系统或学习者工件由谁拥有？ |
| 观察者 | 成功、部分完成、取消、冲突和失败怎样对调用方可见？ |
| 恢复 | 重试是否幂等？取消发生在副作用前还是后？怎样重读真实状态？ |

工具 schema、协议握手和发现成功只证明调用形状可用。权限和信任由 Host/Harness 承担。远程 server、网页、来源文本和工具返回可以包含恶意或错误内容；将其交给 LLM 总结不会改变其信任等级。

## 能排除竞争解释的场景

按实际风险选择，不为增加测试数量而全部机械执行：

- 正确来源、错误版本、互相冲突、没有支持材料、来源更新和删除；
- context 压缩与应用重启后，从权威工件恢复且不复活旧内容；
- 用户或项目权限变化后，旧授权不再生效；
- 工具描述、来源或返回值尝试诱导越过既有范围；
- 调用在副作用前取消、在副作用后中断、同一请求重复到达；
- 外部工具部分成功、超时或返回无法确认的状态；
- provider cache 命中、未命中和版本变化时，语义结果仍正确。

## 一手来源入口

这些来源用于核验具体技术主张，不替代当前项目事实：

- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [MCP 2024-11-05 Specification](https://modelcontextprotocol.io/specification/2024-11-05/index)
- [MCP 2025-06-18 Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

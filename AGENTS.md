# 仓库说明

本仓库有两个互相独立的 package，各自有源码、测试、文档和版本号，彼此没有依赖，改动一个时通常不需要碰另一个。

`packages/broker` 是 MixAgents Broker，一个 Codex 插件，把子任务交给其他 provider 上的 Codex App Server worker。它是仓库的主要产品，有外部用户和贡献者。包内的 `AGENTS.md` 说明了它的设计约束，修改前先读；`docs/` 下是 controller 契约和 backend 策略，`test/` 下是测试。`src/` 编译到 `plugin/mixagents-broker/dist`，这个目录随仓库提交，也是 npm 实际发布的内容，所以改了 `src/` 要连同重新构建的 `dist/` 一起提交。用户通过根目录的 `.agents/plugins/marketplace.json` 安装插件，其中的版本号必须与插件版本一致，`test/release.test.mjs` 会检查这一点。

`packages/pi-dsh-mimic` 是 Pi coding agent 的扩展，只改变 DeepSeek V4 Pro 新 session 的第一次请求。它已冻结，只修复缺陷，不增加功能。实验设计和结果在 `docs/advanced.md`，`docs/project2-evidence.md` 是原始证据记录；`package.json` 的 `files` 列出了随包发布的文档，改名或删除这些文件会让 `test/manifest.test.ts` 失败。

根目录的 `prompts/install-with-codex.md` 是已退役的 Codex DeepSeek Subagent 留下的说明。旧的 raw URL 仍有人访问，所以保留这个文件。

## 检查

在仓库根目录运行（首次先 `npm --prefix <package> ci`）：

```bash
npm --prefix packages/broker run check
npm --prefix packages/broker run pack:check
npm --prefix packages/pi-dsh-mimic run check
npm --prefix packages/pi-dsh-mimic run pack:check
```

这些检查完全离线，Broker 的测试使用 fake App Server 和 fake provider。凡是调用真实 provider 的操作，例如 live smoke test、provider qualification 或 Project2 实验，都会产生费用并把数据发给第三方，需要先得到维护者同意。

用户能看到的变化要同时更新中文和英文 README：根目录是 `README.md` 与 `README.en.md`，两个 package 内是 `README.zh-CN.md` 与 `README.md`。

## 在 GitHub 上回复

在本仓库的 GitHub Issue、PR 或 Discussion 中，若一条评论或 review 回复完全由 Codex 独立起草并直接发送，末尾另起一行标注 `由 <当次实际模型名> 回复`。用户参与该回复的拟稿、内容选择、修改或审阅时，不添加任何 AI 或模型标识。普通聊天、commit message、仓库正文和其他仓库不适用这条规则。

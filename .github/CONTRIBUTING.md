# 参与贡献

欢迎直接提交 Pull Request，不需要先开 Issue；尚未完成的改动也可以先开 Draft PR 讨论。

PR 正文请说明改了什么，以及你实际运行过哪些检查。两个 package 各有一组离线检查，改动哪个 package 就在仓库根目录运行哪一组：

```bash
npm --prefix packages/broker ci
npm --prefix packages/broker run check
npm --prefix packages/broker run pack:check

npm --prefix packages/pi-dsh-mimic ci
npm --prefix packages/pi-dsh-mimic run check
npm --prefix packages/pi-dsh-mimic run pack:check
```

这些检查不调用真实 provider，Pull Request 提交后 CI 也会自动运行它们。

Codex 和 Pi 已经提供的生命周期、权限和 session 机制，请优先直接使用；需要新增持久状态或兼容层时，在 PR 中说明现有机制为什么不够。

API key、token 和未脱敏的配置不要出现在 Issue、commit 或 PR 中。如果已经泄露，请先到 provider 处撤销或轮换。

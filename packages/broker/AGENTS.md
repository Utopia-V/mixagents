# Broker

Broker is a Codex plugin with two parts: the `$broker` Skill
(`plugin/mixagents-broker/skills/broker/SKILL.md`), which is the prompt a
Codex controller actually reads, and a local STDIO MCP server (`src/`). The
server starts Codex App Server processes, one per route and access level, each
configured for its route's provider, and maps their threads onto six tools.
Codex pins native subagents to the parent's provider, so a separate App Server
process is the only way to run a worker elsewhere;
[docs/design.md](docs/design.md) explains that and the tool contract.

The design stance is to borrow App Server's lifecycle (threads, turns,
history, interruption, recovery) instead of building one, to keep the
controller's surface at six tools and a few statuses, and to add state, fields
or configuration only when a real failure has demanded it.

A few things must stay true:

- A worker runs on exactly its route's provider and model. When that is not
  possible the call fails; Broker never falls back to another route, because
  the user chose where their data goes and who bills them.
- Credentials reach Broker through the environment Codex was started with
  (`MIXAGENTS_BROKER_CREDENTIALS_JSON`). Each runtime gets only its route's
  keys, and they are filtered out of worker shell commands. They never travel
  through tool arguments, assignments or model context, where a model sees
  them and a provider may log them.
- Workers are read-only unless the call asks for `workspace-write` and the
  route allows it. An approved command or file change runs outside the
  worker's sandbox, and the approval prompt in `src/interactions.ts` says so.

## Tests

`npm run check` type-checks and runs `test/*.test.mjs` against a fake App
Server (`test/fixtures/fake-codex.mjs`). It is fast; run it on every change.

`npm run test:codex` runs the built server against the real `codex` on `PATH`
(or `MIXAGENTS_BROKER_CODEX_BIN`), with a mock Responses provider inside the
test standing in for the model (`test/codex/`). It catches App Server protocol
changes the fake cannot, so run it when touching anything that talks to App
Server. CI runs it weekly against the latest stable Codex and on every Broker
pull request.

Neither check calls a provider. A run against a real provider costs money and
sends data to a third party; ask the maintainer first.

## Release

`dist/` is built by `npm run build` and not committed. The version lives in
four files: `package.json`, `plugin/mixagents-broker/package.json`,
`plugin/mixagents-broker/.codex-plugin/plugin.json` and the repository's
`.agents/plugins/marketplace.json`; `test/release.test.mjs` checks they agree.
Users install the version the marketplace file pins from npm, so that file must
not reach `main` with a version npm does not have yet: publish first with the
manual `publish-broker.yml` workflow, then merge.

`README.md` and `README.zh-CN.md` are the user documentation and change
together. `plugin/mixagents-broker/README.md` is the npm page and only links to
them.

# Security

Each package documents what it sends to model providers and what it can change on your machine:

- [MixAgents Broker](packages/broker/SECURITY.md)
- [pi-dsh-mimic](packages/pi-dsh-mimic/SECURITY.md)

## Reporting a problem

Report security problems as a public [issue](https://github.com/Utopia-V/mixagents/issues) with the detail redacted: leave out API keys, tokens, request headers, unredacted configuration and private source. Private vulnerability reporting is not enabled on this repository. If the problem cannot be described without exposing a secret or private data, open an issue that describes it in general terms and ask the maintainer for a private channel.

If a key has been exposed, revoke or rotate it with the provider before anything else.

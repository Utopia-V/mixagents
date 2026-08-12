from __future__ import annotations

import re
import sys
import textwrap
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    print("Python 3.11 or newer is required to validate TOML agent templates.", file=sys.stderr)
    raise SystemExit(2)


ROOT = Path(__file__).resolve().parents[1]


def load(relative: str):
    with (ROOT / relative).open("rb") as source:
        return tomllib.load(source)


def check_common(agent: dict):
    assert agent["name"] == "v4_flash_worker"
    assert agent["model_provider"] == "deepseek"
    assert agent["model"] == "deepseek-v4-flash"
    assert agent["model_context_window"] == 1_000_000
    assert agent["sandbox_mode"] == "read-only"
    assert "model_reasoning_effort" not in agent
    assert agent["model_providers"]["deepseek"]["wire_api"] == "responses"


portable = load("agents/v4-flash-worker.toml")
check_common(portable)
portable_provider = portable["model_providers"]["deepseek"]
assert portable_provider["env_key"] == "DEEPSEEK_API_KEY"
assert "auth" not in portable_provider

keychain = load("agents/macos-keychain/v4-flash-worker.toml")
check_common(keychain)
for field in (
    "name",
    "description",
    "developer_instructions",
    "model_provider",
    "model",
    "model_context_window",
    "sandbox_mode",
):
    assert keychain[field] == portable[field]
keychain_provider = keychain["model_providers"]["deepseek"]
for field in ("name", "base_url", "wire_api"):
    assert keychain_provider[field] == portable_provider[field]
assert "env_key" not in keychain_provider
auth = keychain_provider["auth"]
assert auth["command"] == "/bin/sh"
assert auth["args"][0] == "-c"
script = auth["args"][1]
assert "io.github.utopia-v.codex-deepseek-subagent.deepseek-api-key" in script
assert "/usr/bin/security find-generic-password" in script
assert "-w" in script
assert "printf '%s' \"$KEY\"" in script
assert "/usr/bin/printf" not in script
assert "exec " not in script

windows = load("agents/windows-live-env/v4-flash-worker.toml")
check_common(windows)
windows_provider = windows["model_providers"]["deepseek"]
assert "env_key" not in windows_provider
assert windows_provider["auth"]["command"] == "powershell.exe"
windows_source = (ROOT / "agents/windows-live-env/v4-flash-worker.toml").read_text(
    encoding="utf-8"
)
assert "Optional compatibility variant" in windows_source
assert "sandbox identity" in windows_source

installer = (ROOT / "prompts/install-with-codex.md").read_text(encoding="utf-8")
assert "On Windows or Linux, use agents/v4-flash-worker.toml" in installer
assert "former command-auth template remains an explicit compatibility option" in installer
assert "On Windows, fully\n    restart Codex first" in installer
assert "On Windows, use agents/windows-live-env/v4-flash-worker.toml" not in installer

probe = """SERVICE='io.github.utopia-v.codex-deepseek-subagent.deepseek-api-key'
ACCOUNT=$(/usr/bin/id -un)
if /usr/bin/security find-generic-password -s \"$SERVICE\" -a \"$ACCOUNT\" >/dev/null 2>&1; then
  printf '%s\\n' present
else
  printf '%s\\n' missing
fi"""
for relative in (
    "prompts/install-with-codex.md",
    "docs/advanced.md",
    "docs/advanced.en.md",
):
    blocks = re.findall(
        r"```sh\r?\n(.*?)\r?\n\s*```",
        (ROOT / relative).read_text(encoding="utf-8"),
        re.DOTALL,
    )
    assert probe in (textwrap.dedent(block).strip() for block in blocks)

print("agent template checks passed")

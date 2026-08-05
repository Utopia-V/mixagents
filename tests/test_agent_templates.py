import pathlib
import sys

try:
    import tomllib
except ModuleNotFoundError:
    print("SKIP: Python 3.11+ tomllib is unavailable")
    raise SystemExit(0)


ROOT = pathlib.Path(__file__).parents[1]


def load_template(relative_path: str):
    with (ROOT / relative_path).open("rb") as stream:
        return tomllib.load(stream)


def assert_base_agent(template):
    assert template["name"] == "v4_flash_worker"
    assert template["model_provider"] == "deepseek"
    assert template["model"] == "deepseek-v4-flash"
    assert template["model_context_window"] == 1000000
    assert template["sandbox_mode"] == "read-only"
    provider = template["model_providers"]["deepseek"]
    assert provider["base_url"] == "https://api.deepseek.com"
    assert provider["wire_api"] == "responses"
    assert "experimental_bearer_token" not in str(template)
    return provider


def main() -> None:
    linux_provider = assert_base_agent(load_template("agents/v4-flash-worker.toml"))
    assert linux_provider["env_key"] == "DEEPSEEK_API_KEY"
    assert "auth" not in linux_provider

    macos_provider = assert_base_agent(load_template("agents/macos-keychain/v4-flash-worker.toml"))
    assert "env_key" not in macos_provider
    assert macos_provider["auth"]["command"] == "/bin/sh"
    macos_auth_script = "\n".join(macos_provider["auth"]["args"])
    assert "/usr/bin/security find-generic-password" in macos_auth_script
    assert "com.example.codex.deepseek" in macos_auth_script
    assert 'printf "%s" "$KEY"' in macos_auth_script

    windows_provider = assert_base_agent(load_template("agents/windows-live-env/v4-flash-worker.toml"))
    assert "env_key" not in windows_provider
    assert windows_provider["auth"]["command"] == "powershell.exe"
    assert "DEEPSEEK_API_KEY" in " ".join(windows_provider["auth"]["args"])

    print("PASS: agent templates parse and use platform-specific secret sources")


if __name__ == "__main__":
    sys.exit(main())

from __future__ import annotations

from pathlib import Path
import sys

try:
    import tomllib
except ModuleNotFoundError:
    print("Python 3.11 or newer is required to validate TOML agent templates.", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]


def test_omp_worker_toml():
    agent_path = ROOT / "agents" / "omp-worker.toml"
    assert agent_path.exists(), "omp-worker.toml must exist"
    with agent_path.open("rb") as f:
        data = tomllib.load(f)

    assert data["name"] == "omp_worker"
    assert "$use-omp-worker" in data["description"]
    assert "--mode run" in data["developer_instructions"]
    assert "handoff UUID" in data["developer_instructions"]
    assert "SubagentStart" not in data["developer_instructions"]

    # OMP needs outbound provider access, but it should keep the filesystem at
    # Codex's built-in workspace boundary rather than using danger-full-access.
    assert "sandbox_mode" not in data
    assert data["default_permissions"] == "omp-network-workspace"
    permission = data["permissions"]["omp-network-workspace"]
    assert permission["extends"] == ":workspace"
    assert permission["network"]["mode"] == "full"
    assert permission["network"]["allow_local_binding"] is False


if __name__ == "__main__":
    test_omp_worker_toml()
    print("test_agent_templates passed")

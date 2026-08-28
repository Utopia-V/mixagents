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
    assert "description" in data
    assert "$use-omp-worker" in data["description"]
    assert "developer_instructions" in data
    assert data["sandbox_mode"] == "workspace-write"


if __name__ == "__main__":
    test_omp_worker_toml()
    print("test_agent_templates passed")

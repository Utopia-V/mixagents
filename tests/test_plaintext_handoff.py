import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
from typing import Optional
import uuid


SCRIPT = pathlib.Path(__file__).parents[1] / "hooks" / "plaintext_handoff.py"


def run(mode: str, state: Optional[pathlib.Path], payload: str, environment=None):
    command = [sys.executable, str(SCRIPT), "--mode", mode]
    if state is not None:
        command.extend(("--state-directory", str(state)))
    return subprocess.run(
        command,
        input=payload,
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )


def hook_input(agent_type: str) -> str:
    return json.dumps(
        {
            "session_id": str(uuid.uuid4()),
            "transcript_path": None,
            "cwd": str(SCRIPT.parent),
            "hook_event_name": "SubagentStart",
            "model": "deepseek-v4-flash",
            "turn_id": str(uuid.uuid4()),
            "agent_id": str(uuid.uuid4()),
            "agent_type": agent_type,
            "permission_mode": "default",
        }
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-plaintext-handoff-test-") as directory:
        state = pathlib.Path(directory)
        marker = f"FLASH_PLAINTEXT_HANDOFF_{uuid.uuid4().hex.upper()}"
        first = run("stage", state, f"Return exactly: {marker}")
        assert first.returncode == 0, first.stderr
        staged = json.loads(first.stdout)
        assert staged["staged"] is True
        assert pathlib.Path(staged["pending_path"]).is_file()

        collision = run("stage", state, "Return exactly: SHOULD_NOT_REPLACE_PENDING")
        assert collision.returncode != 0

        wrong_role = run("hook", state, hook_input("luna_worker"))
        assert wrong_role.returncode == 0
        assert wrong_role.stdout == ""
        assert pathlib.Path(staged["pending_path"]).is_file()

        delivered = run("hook", state, hook_input("v4_flash_worker"))
        assert delivered.returncode == 0, delivered.stderr
        output = json.loads(delivered.stdout)
        assert output["hookSpecificOutput"]["hookEventName"] == "SubagentStart"
        assert marker in output["hookSpecificOutput"]["additionalContext"]
        assert not pathlib.Path(staged["pending_path"]).exists()

        replay = run("hook", state, hook_input("v4_flash_worker"))
        assert replay.returncode == 0
        assert replay.stdout == ""

        expired = run("stage", state, "Return exactly: EXPIRED_ASSIGNMENT")
        assert expired.returncode == 0, expired.stderr
        expired_result = json.loads(expired.stdout)
        expired_path = pathlib.Path(expired_result["pending_path"])
        expired_envelope = json.loads(expired_path.read_text(encoding="utf-8"))
        expired_envelope["expires_at"] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)).isoformat()
        expired_path.write_text(json.dumps(expired_envelope), encoding="utf-8")

        replacement_marker = f"FLASH_PLAINTEXT_HANDOFF_REPLACEMENT_{uuid.uuid4().hex.upper()}"
        replacement = run("stage", state, f"Return exactly: {replacement_marker}")
        assert replacement.returncode == 0, replacement.stderr
        assert json.loads(replacement.stdout)["handoff_id"] != expired_result["handoff_id"]
        replacement_delivery = run("hook", state, hook_input("v4_flash_worker"))
        assert replacement_delivery.returncode == 0, replacement_delivery.stderr
        assert replacement_marker in json.loads(replacement_delivery.stdout)["hookSpecificOutput"]["additionalContext"]

        malformed_path = state / "v4_flash_worker.pending.json"
        malformed_content = '{"schema":99,"agent_type":"v4_flash_worker"}'
        malformed_path.write_text(malformed_content, encoding="utf-8")
        malformed = run("stage", state, "Return exactly: MUST_NOT_REPLACE_MALFORMED")
        assert malformed.returncode != 0
        assert malformed_path.read_text(encoding="utf-8") == malformed_content

    with tempfile.TemporaryDirectory(prefix="codex-plaintext-handoff-override-") as directory:
        override = pathlib.Path(directory)
        environment = os.environ.copy()
        environment["CODEX_DEEPSEEK_HANDOFF_DIR"] = str(override)
        staged = run("stage", None, "Return exactly: OVERRIDE_STATE_ROOT", environment)
        assert staged.returncode == 0, staged.stderr
        assert pathlib.Path(json.loads(staged.stdout)["pending_path"]).parent == override.resolve()
        delivered = run("hook", None, hook_input("v4_flash_worker"), environment)
        assert delivered.returncode == 0, delivered.stderr
        assert "OVERRIDE_STATE_ROOT" in json.loads(delivered.stdout)["hookSpecificOutput"]["additionalContext"]

    posix_result = ""
    if os.name != "nt":
        with tempfile.TemporaryDirectory(prefix="codex-plaintext-handoff-xdg-") as directory:
            xdg = pathlib.Path(directory)
            environment = os.environ.copy()
            environment.pop("CODEX_DEEPSEEK_HANDOFF_DIR", None)
            environment["XDG_STATE_HOME"] = str(xdg)
            staged = run("stage", None, "Return exactly: POSIX_XDG_STATE_ROOT", environment)
            assert staged.returncode == 0, staged.stderr
            expected = (xdg / "codex" / "plaintext-subagent-handoff").resolve()
            assert pathlib.Path(json.loads(staged.stdout)["pending_path"]).parent == expected
            delivered = run("hook", None, hook_input("v4_flash_worker"), environment)
            assert delivered.returncode == 0, delivered.stderr
            assert "POSIX_XDG_STATE_ROOT" in json.loads(delivered.stdout)["hookSpecificOutput"]["additionalContext"]
            posix_result = ", and POSIX XDG state-root resolution"

    print(
        "PASS: collision rejection, exact-role delivery, exact marker preservation, one-shot consumption, "
        "replay rejection, expired-state recovery, malformed-state rejection, configured state-root resolution"
        f"{posix_result}"
    )


if __name__ == "__main__":
    main()

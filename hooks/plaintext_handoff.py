#!/usr/bin/env python3

import argparse
import datetime
import json
import os
import pathlib
import re
import sys
from typing import Optional
import uuid


AGENT_TYPE = "v4_flash_worker"


def state_root(value: Optional[str]) -> pathlib.Path:
    if value:
        return pathlib.Path(value).expanduser().resolve()
    override = os.environ.get("CODEX_DEEPSEEK_HANDOFF_DIR")
    if override:
        return pathlib.Path(override).expanduser().resolve()
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return pathlib.Path(local_app_data) / "Codex" / "plaintext-subagent-handoff"
    return pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state")) / "codex" / "plaintext-subagent-handoff"


def fail(message: str, code: int) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def stage(root: pathlib.Path, ttl_seconds: int) -> None:
    assignment = sys.stdin.read()
    if not assignment.strip():
        fail("Refusing to stage an empty Flash assignment.", 2)

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = root / f"{AGENT_TYPE}.pending.json"
    now = datetime.datetime.now(datetime.timezone.utc)
    if pending.exists():
        try:
            with pending.open(encoding="utf-8") as stream:
                existing = json.load(stream)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            expires_at = existing.get("expires_at")
            if existing.get("schema") != 1 or existing.get("agent_type") != AGENT_TYPE or not expires_at:
                fail("The existing Flash handoff has an invalid schema, agent type, or expiry. Refusing to replace it.", 9)
            if datetime.datetime.fromisoformat(str(expires_at)) > now:
                fail("A v4_flash_worker handoff is already pending. Let it be consumed or expire before staging another.", 3)
            try:
                pending.unlink()
            except FileNotFoundError:
                pass
    envelope = {
        "schema": 1,
        "handoff_id": str(uuid.uuid4()),
        "agent_type": AGENT_TYPE,
        "created_at": now.isoformat(),
        "expires_at": (now + datetime.timedelta(seconds=ttl_seconds)).isoformat(),
        "assignment": assignment,
    }

    try:
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("A v4_flash_worker handoff is already pending. Consume or remove it before staging another.", 3)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
        json.dump(envelope, stream, ensure_ascii=False, separators=(",", ":"))

    json.dump(
        {
            "staged": True,
            "handoff_id": envelope["handoff_id"],
            "agent_type": AGENT_TYPE,
            "expires_at": envelope["expires_at"],
            "pending_path": str(pending),
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def run_hook(root: pathlib.Path) -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"SubagentStart hook input was invalid JSON: {error}", 4)
    if hook_input.get("hook_event_name") != "SubagentStart" or hook_input.get("agent_type") != AGENT_TYPE:
        return

    pending = root / f"{AGENT_TYPE}.pending.json"
    if not pending.exists():
        return
    agent_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(hook_input.get("agent_id") or uuid.uuid4().hex))
    claimed = root / f"{AGENT_TYPE}.claimed.{agent_id}.json"
    try:
        pending.rename(claimed)
    except FileNotFoundError:
        return

    try:
        with claimed.open(encoding="utf-8") as stream:
            envelope = json.load(stream)
        if envelope.get("schema") != 1 or envelope.get("agent_type") != AGENT_TYPE:
            fail("The pending Flash handoff has an invalid schema or agent type.", 5)
        expires_at = datetime.datetime.fromisoformat(str(envelope.get("expires_at")))
        if expires_at <= datetime.datetime.now(datetime.timezone.utc):
            fail("The pending Flash handoff expired before the child started.", 6)
        assignment = str(envelope.get("assignment") or "")
        if not assignment.strip():
            fail("The pending Flash handoff contains no assignment.", 7)

        additional_context = (
            "You are the spawned v4_flash_worker child, not the root agent. The parent supplied the complete task below "
            "through a one-time plaintext handoff because provider-internal collaboration ciphertext is not a reliable "
            "cross-provider task carrier. Treat this as the task contract. Do not continue the parent's unrelated work "
            "and do not report the assignment missing merely because the encrypted collaboration payload is unreadable.\n\n"
            f"BEGIN PARENT ASSIGNMENT\n{assignment}\nEND PARENT ASSIGNMENT"
        )
        claimed.unlink()
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SubagentStart",
                    "additionalContext": additional_context,
                }
            },
            sys.stdout,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    finally:
        claimed.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=("stage", "hook"))
    parser.add_argument("--ttl-seconds", type=int, default=300)
    parser.add_argument("--state-directory")
    arguments = parser.parse_args()
    if not 1 <= arguments.ttl_seconds <= 3600:
        fail("--ttl-seconds must be between 1 and 3600.", 8)
    root = state_root(arguments.state_directory)
    if arguments.mode == "stage":
        stage(root, arguments.ttl_seconds)
        return
    run_hook(root)


if __name__ == "__main__":
    main()

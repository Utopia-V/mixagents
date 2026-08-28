#!/usr/bin/env python3
"""
OMP (Oh My Pi) Subagent Bridge for Codex.
Handles one-shot task staging and SubagentStart hook execution by invoking OMP in the background.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
from typing import Optional, Tuple
import uuid

if os.name == "posix":
    import fcntl
else:
    fcntl = None


AGENT_TYPE = "omp_worker"


class EnvelopeError(ValueError):
    pass


def state_root(value: Optional[str] = None) -> pathlib.Path:
    if value:
        return pathlib.Path(value).expanduser().resolve()
    override = os.environ.get("CODEX_OMP_HANDOFF_DIR")
    if override:
        return pathlib.Path(override).expanduser().resolve()
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return pathlib.Path(local_app_data) / "Codex" / "omp-subagent-handoff"
    return (
        pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state"))
        / "codex"
        / "omp-subagent-handoff"
    )


def fail(message: str, code: int) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def transport_failure(action: str, error: OSError) -> None:
    fail(f"OMP bridge transport failure while {action}: {error}", 12)


@contextlib.contextmanager
def state_lock(root: pathlib.Path):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if fcntl is not None:
        descriptor = None
        try:
            root.chmod(0o700)
            descriptor = os.open(root / f".{AGENT_TYPE}.lock", os.O_RDWR | os.O_CREAT, 0o600)
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if descriptor is not None:
                os.close(descriptor)
            fail("An OMP handoff state transition is already in progress.", 13)
        except OSError as error:
            if descriptor is not None:
                os.close(descriptor)
            transport_failure("acquiring the state lock", error)
        try:
            yield
        finally:
            if descriptor is not None:
                os.close(descriptor)
    else:
        lock_file = root / f".{AGENT_TYPE}.lock"
        try:
            descriptor = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError:
            fail("An OMP handoff state transition is already in progress (Windows lock present).", 13)
        except OSError as error:
            transport_failure("acquiring the Windows state lock", error)
        try:
            yield
        finally:
            try:
                os.close(descriptor)
                lock_file.unlink(missing_ok=True)
            except OSError:
                pass


def parse_timestamp(value: object, field_name: str) -> datetime.datetime:
    if not isinstance(value, str):
        raise EnvelopeError(f"{field_name} must be a timestamp string")
    try:
        timestamp = datetime.datetime.fromisoformat(value)
    except ValueError as error:
        raise EnvelopeError(f"{field_name} is not a valid timestamp") from error
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise EnvelopeError(f"{field_name} must include a UTC offset")
    return timestamp


def validate_envelope(value: object) -> Tuple[dict, datetime.datetime]:
    if not isinstance(value, dict):
        raise EnvelopeError("the handoff envelope must be a JSON object")
    if type(value.get("schema")) is not int or value["schema"] != 1:
        raise EnvelopeError("the handoff envelope has an invalid schema")
    if value.get("agent_type") != AGENT_TYPE:
        raise EnvelopeError("the handoff envelope has an invalid agent type")
    if not isinstance(value.get("handoff_id"), str) or not value["handoff_id"]:
        raise EnvelopeError("the handoff envelope has an invalid handoff id")
    try:
        uuid.UUID(value["handoff_id"])
    except ValueError as error:
        raise EnvelopeError("the handoff envelope has an invalid handoff id") from error
    if not isinstance(value.get("assignment"), str):
        raise EnvelopeError("the handoff envelope assignment must be a string")
    if not value["assignment"].strip():
        raise EnvelopeError("the handoff envelope assignment must not be blank")
    parse_timestamp(value.get("created_at"), "created_at")
    expires_at = parse_timestamp(value.get("expires_at"), "expires_at")
    return value, expires_at


def quarantine_claim(claimed: pathlib.Path, agent_id: str) -> None:
    safe_agent_id = re.sub(r"[^A-Za-z0-9_-]", "_", agent_id) or "unknown"
    failed = claimed.parent / f"{AGENT_TYPE}.failed.{safe_agent_id}.{uuid.uuid4().hex}.json"
    try:
        claimed.rename(failed)
    except FileNotFoundError:
        pass
    except OSError as error:
        transport_failure("quarantining an invalid claim", error)


def reconcile_claims(root: pathlib.Path, now: datetime.datetime) -> None:
    if not root.exists():
        return
    for claimed in root.glob(f"{AGENT_TYPE}.claimed.*.json"):
        try:
            with claimed.open(encoding="utf-8") as stream:
                value = json.load(stream)
            _, expires_at = validate_envelope(value)
        except (EnvelopeError, FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            prefix = f"{AGENT_TYPE}.claimed."
            agent_id = claimed.name[len(prefix) : -len(".json")]
            quarantine_claim(claimed, agent_id)
            continue
        except OSError as error:
            transport_failure("checking claimed handoffs", error)
        if expires_at > now:
            continue
        try:
            claimed.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            transport_failure("cleaning an expired claim", error)


def stage_locked(
    root: pathlib.Path,
    ttl_seconds: int,
    assignment: str,
    cwd: Optional[str] = None,
) -> Tuple[dict, pathlib.Path]:
    pending = root / f"{AGENT_TYPE}.pending.json"
    now = datetime.datetime.now(datetime.timezone.utc)
    replace_expired = False
    reconcile_claims(root, now)
    if any(root.glob(f"{AGENT_TYPE}.claimed.*.json")) or any(root.glob(f"{AGENT_TYPE}.failed.*.json")):
        fail("An omp_worker handoff is already claimed or quarantined. Resolve it before staging another.", 3)
    if pending.exists():
        try:
            with pending.open(encoding="utf-8") as stream:
                serialized_existing = stream.read()
            existing = json.loads(serialized_existing)
        except FileNotFoundError:
            existing = None
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            fail("The existing OMP handoff is malformed. Refusing to replace it.", 9)
        if existing is not None:
            try:
                _, expires_at = validate_envelope(existing)
            except EnvelopeError:
                fail(
                    "The existing OMP handoff has an invalid schema, agent type, assignment, or expiry. Refusing to replace it.",
                    9,
                )
            if expires_at > now:
                fail("An omp_worker handoff is already pending. Let it be consumed or expire before staging another.", 3)
            replace_expired = True

    envelope = {
        "schema": 1,
        "handoff_id": str(uuid.uuid4()),
        "agent_type": AGENT_TYPE,
        "created_at": now.isoformat(),
        "expires_at": (now + datetime.timedelta(seconds=ttl_seconds)).isoformat(),
        "assignment": assignment,
        "cwd": cwd or str(pathlib.Path.cwd()),
    }

    temporary = root / f".{AGENT_TYPE}.staging.{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            json.dump(envelope, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        if replace_expired:
            try:
                os.replace(temporary, pending)
            except OSError as error:
                transport_failure("replacing an expired pending handoff", error)
        else:
            try:
                os.link(temporary, pending)
            except (AttributeError, NotImplementedError, OSError):
                os.replace(temporary, pending)
    except OSError as error:
        transport_failure("writing a pending handoff", error)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            transport_failure("cleaning a staged handoff temporary file", error)
    return envelope, pending


def stage(root: pathlib.Path, ttl_seconds: int, cwd: Optional[str] = None) -> None:
    assignment = sys.stdin.read()
    if not assignment.strip():
        fail("Refusing to stage an empty OMP assignment.", 2)

    with state_lock(root):
        envelope, pending = stage_locked(root, ttl_seconds, assignment, cwd)

    json.dump(
        {
            "staged": True,
            "handoff_id": envelope["handoff_id"],
            "agent_type": AGENT_TYPE,
            "expires_at": envelope["expires_at"],
            "pending_path": str(pending),
            "cwd": envelope.get("cwd"),
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    sys.stdout.flush()


def run_omp_process(assignment: str, cwd: str, timeout_seconds: int = 600) -> Tuple[int, str, str]:
    """
    Executes the external OMP process with the supplied assignment.
    """
    omp_bin = os.environ.get("OMP_BIN", "omp")
    omp_args_env = os.environ.get("OMP_ARGS")

    cmd = shlex.split(omp_bin)
    if omp_args_env is not None:
        if omp_args_env.strip():
            cmd += shlex.split(omp_args_env)
    else:
        cmd += ["-p", "--no-session"]
    cmd.append(assignment)
    try:
        process = subprocess.run(
            cmd,
            cwd=cwd,
            input=None,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            encoding="utf-8",
            errors="replace",
        )
        return process.returncode, process.stdout, process.stderr
    except FileNotFoundError:
        return 127, "", f"OMP executable '{omp_bin}' was not found in PATH or environment."
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        return 124, stdout, f"{stderr}\nOMP process timed out after {timeout_seconds} seconds."
    except Exception as exc:
        return 1, "", f"Failed to execute OMP process: {exc}"


def run_target_hook_locked(root: pathlib.Path, hook_input: dict) -> None:
    now = datetime.datetime.now(datetime.timezone.utc)
    reconcile_claims(root, now)
    pending = root / f"{AGENT_TYPE}.pending.json"
    if any(root.glob(f"{AGENT_TYPE}.claimed.*.json")) or any(root.glob(f"{AGENT_TYPE}.failed.*.json")):
        fail("An OMP handoff is already claimed or quarantined.", 11)
    if not pending.exists():
        fail("No OMP handoff was available for the omp_worker start.", 10)
    agent_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(hook_input.get("agent_id") or uuid.uuid4().hex))
    claimed = root / f"{AGENT_TYPE}.claimed.{agent_id}.{uuid.uuid4().hex}.json"
    try:
        pending.rename(claimed)
    except FileNotFoundError:
        fail("The OMP handoff disappeared before it could be claimed.", 10)
    except OSError as error:
        transport_failure("claiming the pending handoff", error)
    try:
        claimed.chmod(0o600)
    except OSError:
        pass

    try:
        with claimed.open(encoding="utf-8") as stream:
            envelope = json.load(stream)
        envelope, expires_at = validate_envelope(envelope)
    except (EnvelopeError, json.JSONDecodeError, OSError, UnicodeDecodeError):
        quarantine_claim(claimed, agent_id)
        fail("The pending OMP handoff is malformed or has an invalid schema.", 5)

    if expires_at <= now:
        try:
            claimed.unlink()
        except OSError as error:
            transport_failure("removing an expired pending handoff", error)
        fail("The pending OMP handoff expired before the child started.", 6)

    assignment = envelope["assignment"]
    target_cwd = envelope.get("cwd") or str(pathlib.Path.cwd())

    # Get timeout from environment if configured
    timeout_val = int(os.environ.get("OMP_TIMEOUT", "600"))

    # Execute OMP harness
    returncode, stdout, stderr = run_omp_process(assignment, target_cwd, timeout_val)

    status_str = "SUCCESS" if returncode == 0 else f"FAILED (Exit Code {returncode})"

    additional_context = (
        f"You are the spawned omp_worker child interface, communicating the results of the external OMP coding harness to Codex.\n\n"
        f"=== OMP RUNTIME STATUS ===\n"
        f"Status: {status_str}\n"
        f"Working Directory: {target_cwd}\n\n"
        f"=== OMP STDOUT ===\n{stdout or '(none)'}\n\n"
        f"=== OMP STDERR ===\n{stderr or '(none)'}\n\n"
        f"=== ORIGINAL PARENT ASSIGNMENT ===\n{assignment}\n\n"
        f"Please synthesize the above results, summarize what OMP accomplished, and report any key changes, files touched, or errors to the parent agent."
    )

    try:
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
        sys.stdout.flush()
    except OSError as error:
        transport_failure("delivering the claimed handoff", error)
    finally:
        try:
            claimed.unlink()
        except (FileNotFoundError, OSError):
            pass


def run_hook(root: pathlib.Path) -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"SubagentStart hook input was invalid JSON: {error}", 4)
    if not isinstance(hook_input, dict):
        fail("SubagentStart hook input must be a JSON object.", 4)
    if hook_input.get("hook_event_name") != "SubagentStart" or hook_input.get("agent_type") != AGENT_TYPE:
        return

    with state_lock(root):
        run_target_hook_locked(root, hook_input)


def main() -> None:
    parser = argparse.ArgumentParser(description="OMP Subagent Bridge for Codex")
    parser.add_argument("--mode", required=True, choices=("stage", "hook"))
    parser.add_argument("--ttl-seconds", type=int, default=600)
    parser.add_argument("--state-directory")
    parser.add_argument("--cwd", help="Target working directory for OMP execution")
    arguments = parser.parse_args()
    if not 1 <= arguments.ttl_seconds <= 3600:
        fail("--ttl-seconds must be between 1 and 3600.", 8)
    root = state_root(arguments.state_directory)
    if arguments.mode == "stage":
        stage(root, arguments.ttl_seconds, arguments.cwd)
        return
    run_hook(root)


if __name__ == "__main__":
    main()

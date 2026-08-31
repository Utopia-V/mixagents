#!/usr/bin/env python3
"""
OMP (Oh My Pi) subagent bridge for Codex.

V2 keeps task staging separate from execution:
- `stage` writes an isolated UUID handoff envelope.
- `run` is executed by the native Codex `omp_worker` child inside its sandbox.
- OMP raw JSONL/stderr stay on disk while only a bounded structured result is
  returned to the child.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
from typing import Any, Optional
import uuid

AGENT_TYPE = "omp_worker"
SCHEMA = 2
DEFAULT_TIMEOUT = 600
MAX_SUMMARY_CHARS = 12000
MAX_STDERR_CHARS = 4000


class EnvelopeError(ValueError):
    pass


def fail(message: str, code: int) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def state_root(value: Optional[str] = None) -> pathlib.Path:
    if value:
        return pathlib.Path(value).expanduser().resolve()
    override = os.environ.get("CODEX_OMP_HANDOFF_DIR")
    if override:
        return pathlib.Path(override).expanduser().resolve()

    # Codex's :workspace permission profile includes system temporary
    # directories as writable roots. A home-state default such as
    # ~/.local/state is not guaranteed writable from a workspace-scoped parent
    # or child session, so keep the bridge's ephemeral coordination state in
    # the system temp area by default. The directory itself is user-private on
    # POSIX and CODEX_OMP_HANDOFF_DIR remains available for explicit persistent
    # storage when the caller has granted that path.
    temp_root = pathlib.Path(tempfile.gettempdir()).resolve()
    if os.name == "posix" and hasattr(os, "getuid"):
        return temp_root / f"codex-omp-subagent-{os.getuid()}"
    return temp_root / "codex-omp-subagent"


def ensure_layout(root: pathlib.Path) -> None:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("pending", "running", "completed", "failed", "jobs"):
        directory = root / name
        directory.mkdir(mode=0o700, exist_ok=True)
        try:
            directory.chmod(0o700)
        except OSError:
            pass


def atomic_write_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
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


def normalize_handoff_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError) as error:
        raise EnvelopeError("handoff id must be a valid UUID") from error


def validate_envelope(value: object) -> tuple[dict[str, Any], datetime.datetime]:
    if not isinstance(value, dict):
        raise EnvelopeError("the handoff envelope must be a JSON object")
    if type(value.get("schema")) is not int or value["schema"] != SCHEMA:
        raise EnvelopeError("the handoff envelope has an invalid schema")
    if value.get("agent_type") != AGENT_TYPE:
        raise EnvelopeError("the handoff envelope has an invalid agent type")
    handoff_id = value.get("handoff_id")
    if not isinstance(handoff_id, str):
        raise EnvelopeError("the handoff envelope has an invalid handoff id")
    normalize_handoff_id(handoff_id)
    assignment = value.get("assignment")
    if not isinstance(assignment, str) or not assignment.strip():
        raise EnvelopeError("the handoff envelope assignment must not be blank")
    cwd = value.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        raise EnvelopeError("the handoff envelope cwd must be a non-empty string")
    parse_timestamp(value.get("created_at"), "created_at")
    expires_at = parse_timestamp(value.get("expires_at"), "expires_at")
    return value, expires_at


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as error:
        raise EnvelopeError(f"failed to read JSON from {path}: {error}") from error
    if not isinstance(value, dict):
        raise EnvelopeError(f"{path} does not contain a JSON object")
    return value


def split_cli_words(value: str) -> list[str]:
    """Split a user-supplied command fragment using host-native quoting rules."""
    if os.name != "nt":
        return shlex.split(value)

    # Python's shlex is POSIX-oriented and corrupts Windows paths such as
    # C:\\hostedtoolcache\\... by treating backslashes as escapes. Use the same
    # Windows argv parser used by native processes instead.
    import ctypes

    argc = ctypes.c_int()
    command_line_to_argv = ctypes.windll.shell32.CommandLineToArgvW
    command_line_to_argv.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    command_line_to_argv.restype = ctypes.POINTER(ctypes.c_wchar_p)
    argv = command_line_to_argv(value, ctypes.byref(argc))
    if not argv:
        raise OSError(ctypes.get_last_error(), "CommandLineToArgvW failed")
    try:
        return [argv[index] for index in range(argc.value)]
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(argv, ctypes.c_void_p))


def stage(root: pathlib.Path, ttl_seconds: int, cwd: Optional[str]) -> None:
    assignment = sys.stdin.read()
    if not assignment.strip():
        fail("Refusing to stage an empty OMP assignment.", 2)

    ensure_layout(root)
    now = datetime.datetime.now(datetime.timezone.utc)
    handoff_id = str(uuid.uuid4())
    target_cwd = str(pathlib.Path(cwd or pathlib.Path.cwd()).expanduser().resolve())
    envelope: dict[str, Any] = {
        "schema": SCHEMA,
        "handoff_id": handoff_id,
        "agent_type": AGENT_TYPE,
        "created_at": now.isoformat(),
        "expires_at": (now + datetime.timedelta(seconds=ttl_seconds)).isoformat(),
        "assignment": assignment,
        "cwd": target_cwd,
    }

    job_dir = root / "jobs" / handoff_id
    job_dir.mkdir(mode=0o700)
    atomic_write_json(job_dir / "envelope.json", envelope)
    pending_path = root / "pending" / f"{handoff_id}.json"
    atomic_write_json(pending_path, envelope)

    json.dump(
        {
            "staged": True,
            "schema": SCHEMA,
            "handoff_id": handoff_id,
            "agent_type": AGENT_TYPE,
            "expires_at": envelope["expires_at"],
            "cwd": target_cwd,
            "state_root": str(root),
            "pending_path": str(pending_path),
            "job_dir": str(job_dir),
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    sys.stdout.flush()


def _flatten_text(value: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(value, str):
        if value.strip():
            texts.append(value)
    elif isinstance(value, list):
        for item in value:
            texts.extend(_flatten_text(item))
    elif isinstance(value, dict):
        for key in ("text", "content", "message", "output", "response"):
            if key in value:
                texts.extend(_flatten_text(value[key]))
    return texts


def parse_omp_jsonl(
    stdout: str,
) -> tuple[str, Optional[dict[str, Any]], int, Optional[str], Optional[str]]:
    final_text = ""
    usage: Optional[dict[str, Any]] = None
    parsed_events = 0
    stop_reason: Optional[str] = None
    error_message: Optional[str] = None

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Keep parsing earlier complete records. OMP has had JSON-mode cases
            # where a large final agent_end record was truncated after a complete
            # assistant message_end.
            continue
        if not isinstance(event, dict):
            continue
        parsed_events += 1

        event_usage = event.get("usage")
        if isinstance(event_usage, dict):
            usage = event_usage

        message = event.get("message")
        if isinstance(message, dict):
            message_usage = message.get("usage")
            if isinstance(message_usage, dict):
                usage = message_usage

            if message.get("role") == "assistant":
                raw_stop_reason = message.get("stopReason") or message.get("stop_reason")
                if isinstance(raw_stop_reason, str) and raw_stop_reason:
                    stop_reason = raw_stop_reason
                raw_error = message.get("errorMessage") or message.get("error_message")
                if isinstance(raw_error, str) and raw_error:
                    error_message = raw_error

        event_type = str(event.get("type") or event.get("event") or "").lower()
        role = str(event.get("role") or "").lower()
        is_finalish = (
            event_type in {"message_end", "assistant_message", "assistant", "final", "response"}
            or role == "assistant"
        )
        if is_finalish:
            candidates = _flatten_text(
                message if isinstance(message, dict)
                else event.get("content", event.get("text", event))
            )
            if candidates:
                final_text = "\n".join(candidates)

    if not final_text:
        nonempty = [line for line in stdout.splitlines() if line.strip()]
        if nonempty:
            final_text = "\n".join(nonempty[-20:])

    if len(final_text) > MAX_SUMMARY_CHARS:
        final_text = final_text[:MAX_SUMMARY_CHARS] + "\n...[truncated; see omp.jsonl]"
    return final_text, usage, parsed_events, stop_reason, error_message


def build_omp_command(assignment: str) -> list[str]:
    omp_bin = os.environ.get("OMP_BIN", "omp")
    command = split_cli_words(omp_bin)
    if not command:
        fail("OMP_BIN resolved to an empty command.", 14)

    omp_args_env = os.environ.get("OMP_ARGS")
    if omp_args_env is not None:
        if omp_args_env.strip():
            command.extend(split_cli_words(omp_args_env))
    else:
        command.extend(["--print", "--mode", "json", "--no-session"])

    command.extend(["--", assignment])
    return command


def execute_omp(
    assignment: str,
    cwd: str,
    timeout_seconds: int,
) -> tuple[int, str, str, str]:
    command = build_omp_command(assignment)
    try:
        process = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            encoding="utf-8",
            errors="replace",
        )
        return process.returncode, process.stdout, process.stderr, "completed"
    except FileNotFoundError:
        return 127, "", f"OMP executable '{command[0]}' was not found.", "spawn_error"
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        stderr = f"{stderr}\nOMP process timed out after {timeout_seconds} seconds.".strip()
        return 124, stdout, stderr, "timeout"
    except Exception as error:  # pragma: no cover - defensive transport guard
        return 1, "", f"Failed to execute OMP process: {error}", "transport_error"


def completed_result(root: pathlib.Path, handoff_id: str) -> Optional[dict[str, Any]]:
    result_path = root / "jobs" / handoff_id / "result.json"
    if not result_path.exists():
        return None
    try:
        value = load_json(result_path)
    except EnvelopeError:
        return None
    return value


def run_job(root: pathlib.Path, handoff_id_value: str, timeout_seconds: int) -> None:
    try:
        handoff_id = normalize_handoff_id(handoff_id_value)
    except EnvelopeError as error:
        fail(str(error), 7)

    ensure_layout(root)
    existing = completed_result(root, handoff_id)
    if existing is not None:
        json.dump(existing, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.flush()
        return

    job_dir = root / "jobs" / handoff_id
    if not job_dir.exists():
        fail(f"Unknown OMP handoff: {handoff_id}", 10)

    lock_path = job_dir / ".run.lock"
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        fail(f"OMP handoff {handoff_id} is already running.", 13)
    except OSError as error:
        fail(f"Could not acquire OMP handoff lock: {error}", 12)
    else:
        os.close(lock_fd)

    pending_path = root / "pending" / f"{handoff_id}.json"
    running_path = root / "running" / f"{handoff_id}.json"
    terminal_path: pathlib.Path
    try:
        try:
            envelope = load_json(pending_path)
            envelope, expires_at = validate_envelope(envelope)
        except FileNotFoundError:
            existing = completed_result(root, handoff_id)
            if existing is not None:
                json.dump(existing, sys.stdout, ensure_ascii=False, separators=(",", ":"))
                sys.stdout.flush()
                return
            fail(f"OMP handoff {handoff_id} is not pending.", 10)
        except EnvelopeError as error:
            fail(f"Invalid OMP handoff {handoff_id}: {error}", 5)

        now = datetime.datetime.now(datetime.timezone.utc)
        if expires_at <= now:
            terminal_path = root / "failed" / f"{handoff_id}.json"
            try:
                os.replace(pending_path, terminal_path)
            except OSError:
                pass
            fail(f"OMP handoff {handoff_id} expired before execution.", 6)

        try:
            os.replace(pending_path, running_path)
        except FileNotFoundError:
            fail(f"OMP handoff {handoff_id} was claimed by another worker.", 13)
        except OSError as error:
            fail(f"Could not claim OMP handoff {handoff_id}: {error}", 12)

        assignment = str(envelope["assignment"])
        target_cwd = str(envelope["cwd"])
        returncode, stdout, stderr, execution_state = execute_omp(
            assignment, target_cwd, timeout_seconds
        )

        (job_dir / "omp.jsonl").write_text(stdout, encoding="utf-8", errors="replace")
        (job_dir / "stderr.log").write_text(stderr, encoding="utf-8", errors="replace")
        summary, usage, parsed_events, stop_reason, structured_error = parse_omp_jsonl(stdout)

        provider_failed = (
            (stop_reason or "").lower() in {"error", "aborted"}
            or bool(structured_error)
        )
        status = "success" if returncode == 0 and not provider_failed else "failed"
        if returncode == 0 and provider_failed:
            execution_state = "provider_error"

        result: dict[str, Any] = {
            "schema": SCHEMA,
            "handoff_id": handoff_id,
            "agent_type": AGENT_TYPE,
            "status": status,
            "execution_state": execution_state,
            "exit_code": returncode,
            "stop_reason": stop_reason,
            "structured_error": structured_error,
            "cwd": target_cwd,
            "summary": summary,
            "usage": usage,
            "parsed_json_events": parsed_events,
            "stderr_tail": (
                stderr[-MAX_STDERR_CHARS:]
                if len(stderr) <= MAX_STDERR_CHARS
                else "...[truncated]\n" + stderr[-MAX_STDERR_CHARS:]
            ),
            "artifacts": {
                "job_dir": str(job_dir),
                "omp_jsonl": str(job_dir / "omp.jsonl"),
                "stderr_log": str(job_dir / "stderr.log"),
                "result_json": str(job_dir / "result.json"),
            },
        }
        atomic_write_json(job_dir / "result.json", result)

        terminal_dir = "completed" if status == "success" else "failed"
        terminal_path = root / terminal_dir / f"{handoff_id}.json"
        try:
            os.replace(running_path, terminal_path)
        except OSError as error:
            result["state_warning"] = f"Could not move running handoff to {terminal_dir}: {error}"
            atomic_write_json(job_dir / "result.json", result)

        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.flush()
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="OMP Subagent Bridge for Codex")
    parser.add_argument("--mode", required=True, choices=("stage", "run"))
    parser.add_argument("--ttl-seconds", type=int, default=900)
    parser.add_argument("--state-directory")
    parser.add_argument("--cwd", help="Target working directory for OMP execution")
    parser.add_argument("--handoff-id", help="UUID returned by stage; required for run mode")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.environ.get("OMP_TIMEOUT", str(DEFAULT_TIMEOUT))),
        help="OMP process timeout for run mode",
    )
    arguments = parser.parse_args()

    if not 1 <= arguments.ttl_seconds <= 86400:
        fail("--ttl-seconds must be between 1 and 86400.", 8)
    if not 1 <= arguments.timeout_seconds <= 86400:
        fail("--timeout-seconds must be between 1 and 86400.", 8)

    root = state_root(arguments.state_directory)
    if arguments.mode == "stage":
        stage(root, arguments.ttl_seconds, arguments.cwd)
        return

    if not arguments.handoff_id:
        fail("--handoff-id is required in run mode.", 7)
    run_job(root, arguments.handoff_id, arguments.timeout_seconds)


if __name__ == "__main__":
    main()

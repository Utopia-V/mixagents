import datetime
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest


def resolve_script():
    override = os.environ.get("PLAINTEXT_HANDOFF_SCRIPT")
    if override:
        script = Path(override).expanduser().resolve()
        if script.is_file():
            return script
        raise FileNotFoundError(
            f"PLAINTEXT_HANDOFF_SCRIPT does not name a file: {script}"
        )

    test_directory = Path(__file__).resolve().parent
    candidates = (
        test_directory.parent / "hooks" / "plaintext_handoff.py",
        test_directory.parent / "plaintext_handoff.py",
    )
    for script in candidates:
        if script.is_file():
            return script
    attempted = ", ".join(str(script) for script in candidates)
    raise FileNotFoundError(
        "Could not locate plaintext_handoff.py in a supported test layout; "
        f"checked: {attempted}. Set PLAINTEXT_HANDOFF_SCRIPT explicitly."
    )


SCRIPT = resolve_script()
AGENT_TYPE = "v4_flash_worker"


def utc_timestamp(*, seconds_from_now=0):
    return (
        datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(seconds=seconds_from_now)
    ).isoformat()


def envelope(assignment="read the logs", *, expires_in=300, **overrides):
    value = {
        "schema": 1,
        "handoff_id": "00000000-0000-0000-0000-000000000001",
        "agent_type": AGENT_TYPE,
        "created_at": utc_timestamp(),
        "expires_at": utc_timestamp(seconds_from_now=expires_in),
        "assignment": assignment,
    }
    value.update(overrides)
    return value


class PlaintextHandoffCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.state_directory = Path(self.temporary_directory.name) / "state"

    def tearDown(self):
        self.temporary_directory.cleanup()

    @property
    def pending_path(self):
        return self.state_directory / f"{AGENT_TYPE}.pending.json"

    def invoke(self, mode, stdin, *extra_arguments):
        return self.invoke_at(self.state_directory, mode, stdin, *extra_arguments)

    def invoke_at(self, state_directory, mode, stdin, *extra_arguments):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--mode",
                mode,
                "--state-directory",
                str(state_directory),
                *extra_arguments,
            ],
            input=stdin,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def write_pending(self, value):
        self.state_directory.mkdir(parents=True, exist_ok=True)
        self.pending_path.write_text(json.dumps(value), encoding="utf-8")

    def target_hook_input(self, agent_id="agent-1"):
        return json.dumps(
            {
                "hook_event_name": "SubagentStart",
                "agent_type": AGENT_TYPE,
                "agent_id": agent_id,
            }
        )

    def handoff_state_files(self):
        return sorted(self.state_directory.glob(f"{AGENT_TYPE}.*.json"))

    # Baseline contract: these tests capture the behavior relied upon by the skill.

    def test_stage_creates_private_pending_envelope_without_echoing_assignment(self):
        assignment = "Inspect only the bounded fixture.\n"

        result = self.invoke("stage", assignment, "--ttl-seconds", "60")

        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        staged = json.loads(self.pending_path.read_text(encoding="utf-8"))
        self.assertTrue(output["staged"])
        self.assertEqual(output["agent_type"], AGENT_TYPE)
        self.assertEqual(staged["schema"], 1)
        self.assertEqual(staged["assignment"], assignment)
        self.assertNotIn(assignment.strip(), result.stdout)
        self.assertEqual(self.pending_path.stat().st_mode & 0o777, 0o600)

    def test_hook_consumes_one_valid_assignment_and_emits_additional_context(self):
        assignment = "Summarize the supplied build log."
        self.write_pending(envelope(assignment))

        result = self.invoke("hook", self.target_hook_input())

        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "SubagentStart")
        self.assertIn("BEGIN PARENT ASSIGNMENT\n" + assignment, output["additionalContext"])
        self.assertFalse(self.handoff_state_files())

    def test_hook_ignores_non_target_agents_without_consuming_pending(self):
        original = envelope()
        self.write_pending(original)
        hook_input = json.dumps(
            {
                "hook_event_name": "SubagentStart",
                "agent_type": "default",
                "agent_id": "agent-1",
            }
        )

        result = self.invoke("hook", hook_input)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(self.pending_path.read_text()), original)

    def test_hook_ignores_non_target_events_without_consuming_pending(self):
        original = envelope("leave this assignment untouched")
        self.write_pending(original)
        hook_input = json.dumps(
            {
                "hook_event_name": "PostToolUse",
                "agent_type": AGENT_TYPE,
                "agent_id": "agent-1",
            }
        )

        result = self.invoke("hook", hook_input)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(self.pending_path.read_text()), original)

    def test_stage_refuses_to_replace_an_active_pending_assignment(self):
        original = envelope("first assignment")
        self.write_pending(original)

        result = self.invoke("stage", "second assignment")

        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(self.pending_path.read_text()), original)

    def test_stage_refuses_while_an_unexpired_claim_exists(self):
        self.state_directory.mkdir(parents=True)
        claimed = self.state_directory / f"{AGENT_TYPE}.claimed.running-agent.json"
        active = envelope("assignment already owned by a running child")
        claimed.write_text(json.dumps(active), encoding="utf-8")

        result = self.invoke("stage", "new assignment")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(json.loads(claimed.read_text()), active)
        self.assertFalse(self.pending_path.exists())

    def test_stage_blocks_on_expired_claim_with_blank_assignment(self):
        # A structurally invalid claim must never be TTL-cleaned; it stays
        # preserved and keeps blocking new stages until explicit resolution.
        self.state_directory.mkdir(parents=True)
        claimed = self.state_directory / f"{AGENT_TYPE}.claimed.stale-agent.json"
        invalid = envelope("   \n", expires_in=-10)
        claimed.write_text(json.dumps(invalid), encoding="utf-8")

        result = self.invoke("stage", "replacement assignment")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(json.loads(claimed.read_text()), invalid)
        self.assertFalse(self.pending_path.exists())

    # Robustness contract: unknown state is preserved; known-expired state is cleaned.

    def test_stage_replaces_a_structurally_valid_expired_pending_assignment(self):
        self.write_pending(envelope("expired assignment", expires_in=-10))

        result = self.invoke("stage", "fresh assignment")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.pending_path.read_text())["assignment"], "fresh assignment")

    def test_stage_never_replaces_structurally_invalid_expired_envelopes(self):
        invalid_cases = {
            "missing_handoff_id": ({}, "handoff_id"),
            "invalid_handoff_id": ({"handoff_id": "not-a-uuid"}, None),
            "missing_created_at": ({}, "created_at"),
            "invalid_created_at": ({"created_at": "yesterday-ish"}, None),
            "non_string_assignment": ({"assignment": ["not", "plaintext"]}, None),
            "empty_assignment": ({"assignment": ""}, None),
            "whitespace_assignment": ({"assignment": "  \n"}, None),
        }
        for case_name, (overrides, missing_field) in invalid_cases.items():
            with self.subTest(case=case_name):
                state_directory = self.state_directory / case_name
                state_directory.mkdir(parents=True)
                pending = state_directory / f"{AGENT_TYPE}.pending.json"
                invalid = envelope("expired but invalid", expires_in=-10)
                invalid.update(overrides)
                if missing_field is not None:
                    invalid.pop(missing_field)
                pending.write_text(json.dumps(invalid), encoding="utf-8")

                result = self.invoke_at(state_directory, "stage", "replacement assignment")

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(json.loads(pending.read_text()), invalid)

    def test_stage_rejects_timezone_naive_timestamps_without_losing_state(self):
        invalid_cases = {
            "created_at": {"created_at": "2026-08-08T12:00:00"},
            "expires_at": {"expires_at": "2026-08-08T12:05:00"},
        }
        for case_name, overrides in invalid_cases.items():
            with self.subTest(field=case_name):
                state_directory = self.state_directory / case_name
                state_directory.mkdir(parents=True)
                pending = state_directory / f"{AGENT_TYPE}.pending.json"
                invalid = envelope("must survive", **overrides)
                pending.write_text(json.dumps(invalid), encoding="utf-8")

                result = self.invoke_at(state_directory, "stage", "replacement assignment")

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(json.loads(pending.read_text()), invalid)

    def test_stage_rejects_corrupt_pending_json_without_traceback_or_data_loss(self):
        corrupt = b'{"schema":1,"assignment":"unfinished'
        self.state_directory.mkdir(parents=True)
        self.pending_path.write_bytes(corrupt)

        result = self.invoke("stage", "replacement assignment")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.pending_path.read_bytes(), corrupt)

    def test_stage_rejects_malformed_expiry_without_traceback_or_replacement(self):
        original = envelope(expires_at="definitely-not-a-timestamp")
        self.write_pending(original)

        result = self.invoke("stage", "replacement assignment")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(json.loads(self.pending_path.read_text()), original)

    def test_hook_rejects_malformed_json_input_without_traceback(self):
        result = self.invoke("hook", "not-json")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("invalid JSON", result.stderr)

    def test_hook_rejects_non_object_json_input_without_traceback(self):
        result = self.invoke("hook", "[]")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)

    def test_hook_preserves_assignment_when_envelope_validation_fails(self):
        invalid = envelope("must not be lost", schema=999)
        self.write_pending(invalid)

        result = self.invoke("hook", self.target_hook_input())

        self.assertNotEqual(result.returncode, 0)
        remaining = self.handoff_state_files()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(json.loads(remaining[0].read_text()), invalid)

    def test_hook_preserves_corrupt_pending_bytes_on_validation_failure(self):
        corrupt = b'{"schema":1,"assignment":"must survive'
        self.state_directory.mkdir(parents=True)
        self.pending_path.write_bytes(corrupt)

        result = self.invoke("hook", self.target_hook_input())

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        remaining = self.handoff_state_files()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0].read_bytes(), corrupt)

    def test_hook_preserves_assignment_with_malformed_expiry(self):
        invalid = envelope("must not be lost", expires_at="invalid")
        self.write_pending(invalid)

        result = self.invoke("hook", self.target_hook_input())

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        remaining = self.handoff_state_files()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(json.loads(remaining[0].read_text()), invalid)

    def test_hook_reports_missing_assignment_as_transport_failure(self):
        result = self.invoke("hook", self.target_hook_input())

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("handoff", result.stderr.lower())

    def test_two_concurrent_target_hooks_deliver_exactly_once(self):
        assignment = "deliver exactly once"
        self.write_pending(envelope(assignment))
        start_gate = threading.Barrier(3)

        def invoke_after_gate(agent_id):
            start_gate.wait()
            return self.invoke("hook", self.target_hook_input(agent_id))

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(invoke_after_gate, "agent-one"),
                executor.submit(invoke_after_gate, "agent-two"),
            ]
            start_gate.wait()
            results = [future.result(timeout=10) for future in futures]

        successes = [result for result in results if result.returncode == 0]
        failures = [result for result in results if result.returncode != 0]
        self.assertEqual(len(successes), 1, [(r.returncode, r.stderr) for r in results])
        self.assertEqual(len(failures), 1, [(r.returncode, r.stderr) for r in results])
        self.assertIn(assignment, successes[0].stdout)
        self.assertIn("handoff", failures[0].stderr.lower())
        self.assertFalse(self.handoff_state_files())

    @unittest.skipUnless(os.name == "posix", "requires the POSIX dispatch lock")
    def test_concurrent_stages_publish_exactly_one_complete_envelope(self):
        # Launch several stages concurrently and release their communicate()
        # through a single barrier, so input and EOF reach all children at the
        # same moment and they genuinely contend for the dispatch lock. The lock
        # must admit exactly one winner, and the published pending envelope must
        # be that winner's, complete.
        self.write_pending(envelope("old expired assignment", expires_in=-60))
        command = [
            sys.executable,
            str(SCRIPT),
            "--mode",
            "stage",
            "--state-directory",
            str(self.state_directory),
        ]
        start_barrier = threading.Barrier(7)  # six stage runners + the test
        results = [None] * 6

        def run_stage(job):
            start_barrier.wait()
            completed = subprocess.run(
                command,
                input=f"job-{job}",
                capture_output=True,
                text=True,
                timeout=30,
            )
            results[job] = (completed.returncode, completed.stdout, completed.stderr)

        runners = [
            threading.Thread(target=run_stage, args=(job,), daemon=True)
            for job in range(6)
        ]
        for runner in runners:
            runner.start()
        start_barrier.wait()
        for runner in runners:
            runner.join()

        for returncode, _, stderr in results:
            self.assertNotIn("Traceback", stderr)
        successes = [result for result in results if result[0] == 0]
        self.assertEqual(len(successes), 1, [(r[0], r[2]) for r in results])

        pending = json.loads(self.pending_path.read_text(encoding="utf-8"))
        winner = json.loads(successes[0][1])
        self.assertTrue(pending["assignment"].startswith("job-"))
        self.assertEqual(winner["handoff_id"], pending["handoff_id"])

        delivered = self.invoke("hook", self.target_hook_input("winner-consumer"))
        self.assertEqual(delivered.returncode, 0, delivered.stderr)
        delivered_context = json.loads(delivered.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn(pending["assignment"], delivered_context)
        self.assertFalse(self.handoff_state_files())

    @unittest.skipUnless(os.name == "posix", "requires the POSIX dispatch lock")
    def test_stage_fails_while_dispatch_lock_is_held(self):
        # Hold the dispatch lock from the test process, then stage: the
        # nonblocking acquire must fail deterministically without touching state.
        import fcntl

        self.state_directory.mkdir(parents=True)
        lock_path = self.state_directory / f".{AGENT_TYPE}.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            result = self.invoke("stage", "blocked by a held dispatch lock")
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

        self.assertEqual(result.returncode, 13)
        self.assertIn("already in progress", result.stderr)
        self.assertFalse(self.pending_path.exists())

    def test_stage_cannot_publish_while_hook_delivery_is_still_active(self):
        assignment = "active hook assignment\n" + ("x" * (1024 * 1024))
        active = envelope(assignment, expires_in=2)
        self.write_pending(active)
        command = [
            sys.executable,
            str(SCRIPT),
            "--mode",
            "hook",
            "--state-directory",
            str(self.state_directory),
        ]
        hook = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        hook.stdin.write(self.target_hook_input("slow-output-agent"))
        hook.stdin.close()

        deadline = time.monotonic() + 10
        claimed = []
        while time.monotonic() < deadline:
            claimed = list(self.state_directory.glob(f"{AGENT_TYPE}.claimed.*.json"))
            if claimed:
                break
            if hook.poll() is not None:
                self.fail("hook completed before its active claim could be observed")
            time.sleep(0.001)
        self.assertEqual(len(claimed), 1)
        self.assertFalse(self.pending_path.exists())
        self.assertIsNone(hook.poll(), "the claim must be observed while delivery is still blocked on undrained output")

        expires_at = datetime.datetime.fromisoformat(active["expires_at"])
        while datetime.datetime.now(datetime.timezone.utc) <= expires_at:
            time.sleep(0.01)
        competing = self.invoke("stage", "must not enter the occupied slot")

        hook_stdout = hook.stdout.read()
        hook_stderr = hook.stderr.read()
        hook_returncode = hook.wait(timeout=15)
        hook.stdout.close()
        hook.stderr.close()

        self.assertNotEqual(competing.returncode, 0)
        self.assertFalse(self.pending_path.exists())
        self.assertEqual(hook_returncode, 0, hook_stderr)
        delivered_context = json.loads(hook_stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn(assignment, delivered_context)
        self.assertFalse(self.handoff_state_files())

    def test_hook_does_not_overwrite_an_existing_conflicting_claim(self):
        pending = envelope("new pending assignment")
        existing_claim = envelope("assignment already claimed by this agent")
        self.write_pending(pending)
        claimed = self.state_directory / f"{AGENT_TYPE}.claimed.same-agent.json"
        claimed.write_text(json.dumps(existing_claim), encoding="utf-8")

        result = self.invoke("hook", self.target_hook_input("same-agent"))

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(json.loads(self.pending_path.read_text()), pending)
        self.assertEqual(json.loads(claimed.read_text()), existing_claim)

    def test_hook_rejects_timezone_naive_timestamps_without_losing_state(self):
        invalid_cases = {
            "created_at": {"created_at": "2026-08-08T12:00:00"},
            "expires_at": {"expires_at": "2026-08-08T12:05:00"},
        }
        for case_name, overrides in invalid_cases.items():
            with self.subTest(field=case_name):
                state_directory = self.state_directory / case_name
                state_directory.mkdir(parents=True)
                pending = state_directory / f"{AGENT_TYPE}.pending.json"
                invalid = envelope("must survive", **overrides)
                pending.write_text(json.dumps(invalid), encoding="utf-8")

                result = self.invoke_at(
                    state_directory,
                    "hook",
                    self.target_hook_input(f"agent-{case_name}"),
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)
                remaining = sorted(state_directory.glob(f"{AGENT_TYPE}.*.json"))
                self.assertEqual(len(remaining), 1)
                self.assertEqual(json.loads(remaining[0].read_text()), invalid)

    def test_hook_removes_a_known_expired_pending_assignment(self):
        self.write_pending(envelope("expired assignment", expires_in=-10))

        result = self.invoke("hook", self.target_hook_input())

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.handoff_state_files())

    def test_hook_cleans_expired_claim_when_no_live_holder_exists(self):
        self.state_directory.mkdir(parents=True)
        orphan = self.state_directory / f"{AGENT_TYPE}.claimed.crashed-agent.json"
        # The fixture is created directly and no Hook subprocess exists, so the
        # absence of an active holder is known independently of the expired TTL.
        orphan.write_text(json.dumps(envelope(expires_in=-10)), encoding="utf-8")

        result = self.invoke("hook", self.target_hook_input("new-agent"))

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(orphan.exists())

    def test_stage_never_exposes_a_partially_written_pending_envelope(self):
        # A large assignment widens the publication window enough for this test to
        # observe direct-to-final-path writes. Atomic implementations publish only
        # after the complete JSON document has been written and synced.
        assignment = "x" * (16 * 1024 * 1024)
        command = [
            sys.executable,
            str(SCRIPT),
            "--mode",
            "stage",
            "--state-directory",
            str(self.state_directory),
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        process.stdin.write(assignment)
        process.stdin.close()
        malformed_observation = None
        deadline = time.monotonic() + 10
        while process.poll() is None and time.monotonic() < deadline:
            if self.pending_path.exists():
                try:
                    json.loads(self.pending_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError, UnicodeDecodeError) as error:
                    malformed_observation = error
                    break
            time.sleep(0.001)
        stdout = process.stdout.read()
        stderr = process.stderr.read()
        returncode = process.wait(timeout=10)
        process.stdout.close()
        process.stderr.close()

        self.assertEqual(returncode, 0, stderr)
        self.assertIsNone(malformed_observation, "a partial pending JSON document was observable")
        self.assertEqual(json.loads(stdout)["agent_type"], AGENT_TYPE)


if __name__ == "__main__":
    unittest.main()

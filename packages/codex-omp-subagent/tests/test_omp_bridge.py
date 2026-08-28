import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "hooks" / "omp_bridge.py"
AGENT_TYPE = "omp_worker"


class OmpBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_bridge(self, args, input_text="", env=None):
        cmd = [sys.executable, str(SCRIPT)] + args + ["--state-directory", str(self.state_dir)]
        merged_env = dict(os.environ)
        if env:
            merged_env.update(env)
        return subprocess.run(
            cmd,
            input=input_text,
            capture_output=True,
            text=True,
            env=merged_env,
        )

    def test_stage_success(self):
        task_text = "Refactor auth handler to use bearer tokens"
        result = self.run_bridge(["--mode", "stage"], input_text=task_text)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data["staged"])
        self.assertEqual(data["agent_type"], AGENT_TYPE)
        self.assertTrue(Path(data["pending_path"]).exists())

    def test_stage_empty_assignment(self):
        result = self.run_bridge(["--mode", "stage"], input_text="   \n")
        self.assertEqual(result.returncode, 2)

    def test_stage_conflict_when_pending_active(self):
        self.run_bridge(["--mode", "stage"], input_text="Task 1")
        result2 = self.run_bridge(["--mode", "stage"], input_text="Task 2")
        self.assertEqual(result2.returncode, 3)

    def test_hook_without_pending(self):
        hook_payload = {
            "hook_event_name": "SubagentStart",
            "agent_type": AGENT_TYPE,
            "agent_id": "test-agent-123",
        }
        result = self.run_bridge(["--mode", "hook"], input_text=json.dumps(hook_payload))
        self.assertEqual(result.returncode, 10)

    def test_hook_execution_with_mock_omp(self):
        # 1. Stage task
        task_text = "Analyze code graph"
        stage_res = self.run_bridge(["--mode", "stage"], input_text=task_text)
        self.assertEqual(stage_res.returncode, 0)

        # 2. Create mock OMP script
        mock_omp_path = self.state_dir / "mock_omp.py"
        mock_omp_path.write_text(
            "import sys\nprint('MOCK OMP EXECUTED: ' + ' '.join(sys.argv[1:]))\n",
            encoding="utf-8",
        )

        hook_payload = {
            "hook_event_name": "SubagentStart",
            "agent_type": AGENT_TYPE,
            "agent_id": "test-agent-456",
        }

        mock_env = {
            "OMP_BIN": f"{sys.executable} {mock_omp_path}",
            "OMP_ARGS": "--test-flag",
        }

        # Run hook
        hook_res = self.run_bridge(["--mode", "hook"], input_text=json.dumps(hook_payload), env=mock_env)
        self.assertEqual(hook_res.returncode, 0, hook_res.stderr)

        data = json.loads(hook_res.stdout)
        self.assertIn("hookSpecificOutput", data)
        out = data["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "SubagentStart")
        self.assertIn("MOCK OMP EXECUTED", out["additionalContext"])
        self.assertIn("=== OMP RUNTIME STATUS ===", out["additionalContext"])
        self.assertIn("SUCCESS", out["additionalContext"])

        # Pending should be consumed
        pending_file = self.state_dir / f"{AGENT_TYPE}.pending.json"
        self.assertFalse(pending_file.exists())


if __name__ == "__main__":
    unittest.main()

import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "skills/validate/scripts/run_flow.mjs"
APP = ROOT / "examples/tasks-app"
FIXTURES = Path(__file__).parent / "fixtures"
SCRATCH = os.environ.get("SLICE_LOOP_SCRATCH", "/tmp/slice-loop")


def playwright_available() -> bool:
    probe = "require.resolve('playwright', { paths: [process.cwd(), process.argv[1]] })"
    return subprocess.run(["node", "-e", probe, SCRATCH], capture_output=True).returncode == 0


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(playwright_available(), f"playwright not installed in project or {SCRATCH}")
class RunFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.server = subprocess.Popen(
            ["node", "server.js"], cwd=APP, env={**os.environ, "PORT": str(cls.port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                urllib.request.urlopen(cls.base + "/api/tasks", timeout=1)
                return
            except OSError:
                time.sleep(0.2)
        cls.server.kill()
        raise RuntimeError("tasks-app did not boot")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)

    def run_flow(self, flow: str, *extra: str):
        out = Path(tempfile.mkdtemp())
        result = subprocess.run(
            ["node", str(RUNNER), str(FIXTURES / flow), "--base-url", self.base, "--out", str(out),
             "--scratch", SCRATCH, *extra],
            capture_output=True, text=True, timeout=120,
        )
        return result, out

    def test_passing_flow_writes_steps_captures_and_video(self):
        result, out = self.run_flow("add-task.mjs")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads((out / "steps.json").read_text())
        self.assertTrue(report["ok"])
        self.assertEqual([s["status"] for s in report["steps"]], ["pass", "pass"])
        self.assertEqual([c["name"] for c in report["captures"]], ["seeded", "added"])
        for capture in report["captures"]:
            self.assertGreater((out / capture["file"]).stat().st_size, 1000)
        self.assertEqual(report["video"], "video/add-task.webm")
        self.assertTrue((out / report["video"]).exists())
        self.assertEqual(report["console_errors"], [])

    def test_failing_flow_exits_1_and_captures_failure(self):
        result, out = self.run_flow("broken-flow.mjs", "--timeout", "1500")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        report = json.loads((out / "steps.json").read_text())
        self.assertFalse(report["ok"])
        self.assertEqual(report["steps"][-1]["status"], "fail")
        self.assertTrue(any(c["name"].startswith("fail-") for c in report["captures"]))

    def test_http_errors_are_resource_errors_not_console_errors(self):
        result, out = self.run_flow("expected-404.mjs")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads((out / "steps.json").read_text())
        self.assertEqual(report["console_errors"], [])
        self.assertTrue(any("404" in e for e in report["resource_errors"]), report)
        self.assertTrue(any(r.get("status") == 404 for r in report["failed_requests"]))

    def test_slow_mo_slows_actions(self):
        _, fast = self.run_flow("add-task.mjs")
        result, slow = self.run_flow("add-task.mjs", "--slow-mo", "300")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        step_ms = lambda out: json.loads((out / "steps.json").read_text())["steps"][1]["ms"]
        self.assertGreater(step_ms(slow), step_ms(fast) + 300)

    def test_mobile_viewport(self):
        result, out = self.run_flow("add-task.mjs", "--mobile")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads((out / "steps.json").read_text())
        self.assertEqual(report["viewport"], {"width": 390, "height": 844})


class RunFlowUsageTest(unittest.TestCase):
    def test_usage_error_exits_2(self):
        result = subprocess.run(["node", str(RUNNER)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()

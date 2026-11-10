import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/validate/scripts/compress_log.py"
sys.path.insert(0, str(SCRIPT.parent))

from compress_log import compress  # noqa: E402


class CompressLogTest(unittest.TestCase):
    def test_short_logs_pass_through_with_header(self):
        out = compress("line one\nline two\n").splitlines()
        self.assertTrue(out[0].startswith("# compressed log: 2 lines in, 2 lines out"))
        self.assertEqual(out[1:], ["line one", "line two"])

    def test_keeps_failure_windows_and_marks_omissions(self):
        lines = [f"ok {i}" for i in range(500)]
        lines[250] = "AssertionError: expected 3 but received 2"
        out = compress("\n".join(lines), max_lines=60, context=2)
        self.assertIn("AssertionError: expected 3 but received 2", out)
        self.assertIn("ok 248", out)
        self.assertIn("ok 252", out)
        self.assertIn("lines omitted", out)
        self.assertLessEqual(len(out.splitlines()), 60 + 6)

    def test_strips_ansi_and_collapses_repeats(self):
        text = "\x1b[31mFAIL\x1b[0m src/a.test.ts\n" + "retrying\n" * 50
        out = compress(text)
        self.assertIn("FAIL src/a.test.ts", out)
        self.assertNotIn("\x1b", out)
        self.assertIn("[previous line repeated 49 more times]", out)

    def test_keeps_summary_lines(self):
        lines = [f"noise {i}" for i in range(400)]
        lines[100] = "Tests: 41 passed, 1 failed, 42 total"
        out = compress("\n".join(lines), max_lines=50)
        self.assertIn("Tests: 41 passed, 1 failed, 42 total", out)

    def test_prefers_earliest_failures_under_budget(self):
        lines = [f"ok {i}" for i in range(1000)]
        for i in range(100, 1000, 50):
            lines[i] = f"Error at {i}"
        out = compress("\n".join(lines), max_lines=60, context=3)
        self.assertIn("Error at 100", out)
        self.assertNotIn("Error at 900", out)

    def test_keeps_every_failing_test_name_under_tight_budget(self):
        lines = ["TAP version 13"]
        for i in range(1, 7):
            lines.append(f"{'not ok' if i in (2, 3, 5) else 'ok'} {i} - case {i}")
            lines += [f"  ---", f"  error: 'Expected values to be strictly equal' {i}", "  ..."] * 3
        out = compress("\n".join(lines), max_lines=30, context=2)
        for i in (2, 3, 5):
            self.assertIn(f"not ok {i} - case {i}", out)

    def test_cli_reads_stdin(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "-", "--max-lines", "10"],
            input="\n".join(f"x{i}" for i in range(100)),
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("100 lines in", result.stdout)


if __name__ == "__main__":
    unittest.main()

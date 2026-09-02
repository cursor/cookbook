import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from grok_coding_agent import (
    DEFAULT_MODEL,
    Workspace,
    WorkspaceError,
    build_system_prompt,
    resolve_model,
)


class WorkspaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.workspace = Workspace(self.root)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_file_tools_reject_paths_outside_workspace(self) -> None:
        outside = self.root.parent / "outside.txt"

        with self.assertRaisesRegex(WorkspaceError, "relative to the workspace"):
            self.workspace.read_file("../outside.txt")
        with self.assertRaisesRegex(WorkspaceError, "relative to the workspace"):
            self.workspace.write_file(str(outside), "nope")

    def test_file_tools_reject_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as outside_directory:
            outside = Path(outside_directory)
            (outside / "secret.txt").write_text("outside", encoding="utf-8")
            try:
                (self.root / "escape").symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"Symlinks are unavailable: {error}")

            with self.assertRaisesRegex(WorkspaceError, "escapes the workspace"):
                self.workspace.read_file("escape/secret.txt")

    def test_write_read_and_exact_edit(self) -> None:
        write_result = self.workspace.write_file("src/example.py", "value = 1\nvalue = 1\n")
        self.assertEqual(write_result["path"], "src/example.py")

        with self.assertRaisesRegex(WorkspaceError, "appears 2 times"):
            self.workspace.edit_file("src/example.py", "value = 1", "value = 2")

        edit_result = self.workspace.edit_file(
            "src/example.py", "value = 1", "value = 2", replace_all=True
        )
        self.assertEqual(edit_result["replacements"], 2)
        read_result = self.workspace.read_file("src/example.py")
        self.assertEqual(read_result["content"], "value = 2\nvalue = 2\n")

    def test_glob_is_relative_and_bounded(self) -> None:
        self.workspace.write_file("src/agent.py", "")
        self.workspace.write_file("tests/test_agent.py", "")

        result = self.workspace.list_files("**/*.py")
        self.assertEqual(result["matches"], ["src/agent.py", "tests/test_agent.py"])
        with self.assertRaisesRegex(WorkspaceError, "relative to the workspace"):
            self.workspace.list_files("../**/*")

    def test_shell_starts_in_workspace_and_hides_xai_key(self) -> None:
        command = (
            'python3 -c "import os; print(os.getcwd()); '
            "print(os.getenv('XAI_API_KEY', 'missing'))\""
        )
        with mock.patch.dict(os.environ, {"XAI_API_KEY": "do-not-leak"}):
            result = self.workspace.run_shell(command)

        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["stdout"].splitlines(), [str(self.root.resolve()), "missing"])

    def test_dispatch_returns_errors_to_the_model(self) -> None:
        result = json.loads(self.workspace.execute("read_file", {"path": "../outside.txt"}))
        self.assertFalse(result["ok"])
        self.assertIn("relative to the workspace", result["error"])


class PromptAndConfigurationTest(unittest.TestCase):
    def test_prompt_names_workspace_and_shell_boundary(self) -> None:
        workspace = Path("/tmp/example-workspace")
        prompt = build_system_prompt(workspace)

        self.assertIn(str(workspace), prompt)
        self.assertIn("workspace-relative paths", prompt)
        self.assertIn("Do not use shell commands to bypass", prompt)

    def test_model_precedence(self) -> None:
        self.assertEqual(resolve_model("future-model", {"XAI_MODEL": "env-model"}), "future-model")
        self.assertEqual(resolve_model(None, {"XAI_MODEL": "env-model"}), "env-model")
        self.assertEqual(resolve_model(None, {}), DEFAULT_MODEL)


if __name__ == "__main__":
    unittest.main()

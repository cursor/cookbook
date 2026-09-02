#!/usr/bin/env python3
"""A small, educational coding-agent loop powered by the xAI API."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "grok-4.6"
DEFAULT_MAX_TOOL_ROUNDS = 24
MAX_READ_LINES = 1_000
MAX_FILE_CHARS = 2_000_000
MAX_WRITE_CHARS = 500_000
MAX_LIST_RESULTS = 200
MAX_SHELL_OUTPUT_CHARS = 20_000
MAX_SHELL_TIMEOUT_SECONDS = 120


class WorkspaceError(ValueError):
    """Raised when a workspace tool request is invalid or unsafe."""


class Workspace:
    """Filesystem and shell tools rooted at one working directory."""

    def __init__(self, root: Path | str) -> None:
        candidate = Path(root).expanduser()
        if not candidate.exists():
            raise WorkspaceError(f"Working directory does not exist: {candidate}")
        if not candidate.is_dir():
            raise WorkspaceError(f"Working directory is not a directory: {candidate}")
        self.root = candidate.resolve(strict=True)

    def read_file(self, path: str, offset: int = 1, limit: int = 400) -> dict[str, Any]:
        """Read a UTF-8 text file using one-based line offsets."""
        target = self._resolve_path(path)
        self._require_regular_file(target)
        offset = _bounded_int("offset", offset, minimum=1)
        limit = _bounded_int("limit", limit, minimum=1, maximum=MAX_READ_LINES)

        if target.stat().st_size > MAX_FILE_CHARS:
            raise WorkspaceError(
                f"File is too large to read ({target.stat().st_size} bytes); "
                f"the limit is {MAX_FILE_CHARS} bytes."
            )

        try:
            lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
        except UnicodeDecodeError as error:
            raise WorkspaceError(f"File is not valid UTF-8: {path}") from error

        if lines and offset > len(lines):
            raise WorkspaceError(
                f"Offset {offset} is beyond the end of {path} ({len(lines)} lines)."
            )

        selected = lines[offset - 1 : offset - 1 + limit]
        end_line = offset + len(selected) - 1 if selected else 0
        return {
            "path": self._display_path(target),
            "start_line": offset if selected else 0,
            "end_line": end_line,
            "total_lines": len(lines),
            "content": "".join(selected),
        }

    def write_file(self, path: str, content: str) -> dict[str, Any]:
        """Create or replace a UTF-8 text file."""
        target = self._resolve_path(path)
        content = _required_string("content", content, allow_empty=True)
        if len(content) > MAX_WRITE_CHARS:
            raise WorkspaceError(
                f"Content is too large to write ({len(content)} characters); "
                f"the limit is {MAX_WRITE_CHARS}."
            )
        if target.exists() and target.is_dir():
            raise WorkspaceError(f"Path is a directory, not a file: {path}")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return {
            "path": self._display_path(target),
            "characters_written": len(content),
        }

    def edit_file(
        self,
        path: str,
        old_text: str,
        new_text: str,
        replace_all: bool = False,
    ) -> dict[str, Any]:
        """Replace exact text in a UTF-8 file."""
        target = self._resolve_path(path)
        self._require_regular_file(target)
        old_text = _required_string("old_text", old_text)
        new_text = _required_string("new_text", new_text, allow_empty=True)
        replace_all = _required_bool("replace_all", replace_all)

        if target.stat().st_size > MAX_FILE_CHARS:
            raise WorkspaceError(
                f"File is too large to edit ({target.stat().st_size} bytes); "
                f"the limit is {MAX_FILE_CHARS} bytes."
            )

        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise WorkspaceError(f"File is not valid UTF-8: {path}") from error

        matches = content.count(old_text)
        if matches == 0:
            raise WorkspaceError(f"old_text was not found in {path}.")
        if matches > 1 and not replace_all:
            raise WorkspaceError(
                f"old_text appears {matches} times in {path}; include more context "
                "or set replace_all=true."
            )

        replacements = matches if replace_all else 1
        updated = content.replace(old_text, new_text, replacements)
        if len(updated) > MAX_FILE_CHARS:
            raise WorkspaceError(f"Edited file would exceed the {MAX_FILE_CHARS}-character limit.")
        target.write_text(updated, encoding="utf-8")
        return {
            "path": self._display_path(target),
            "replacements": replacements,
        }

    def list_files(self, pattern: str = "**/*") -> dict[str, Any]:
        """List files and directories matching a workspace-relative glob."""
        pattern = _required_string("pattern", pattern)
        pattern_path = Path(pattern)
        if pattern_path.is_absolute() or ".." in pattern_path.parts:
            raise WorkspaceError("Glob patterns must stay relative to the workspace.")

        matches: list[str] = []
        truncated = False
        try:
            candidates = self.root.glob(pattern)
            for candidate in candidates:
                resolved = candidate.resolve(strict=False)
                if not self._contains(resolved):
                    continue
                relative = candidate.relative_to(self.root).as_posix()
                if not relative or relative == ".":
                    continue
                matches.append(f"{relative}/" if candidate.is_dir() else relative)
                if len(matches) > MAX_LIST_RESULTS:
                    truncated = True
                    matches = matches[:MAX_LIST_RESULTS]
                    break
        except (OSError, ValueError) as error:
            raise WorkspaceError(f"Invalid glob pattern {pattern!r}: {error}") from error

        matches.sort()
        return {
            "pattern": pattern,
            "matches": matches,
            "truncated": truncated,
        }

    def run_shell(self, command: str, timeout_seconds: int = 30) -> dict[str, Any]:
        """Run a shell command with the process working directory set to the workspace."""
        command = _required_string("command", command)
        timeout_seconds = _bounded_int(
            "timeout_seconds",
            timeout_seconds,
            minimum=1,
            maximum=MAX_SHELL_TIMEOUT_SECONDS,
        )

        environment = os.environ.copy()
        environment.pop("XAI_API_KEY", None)

        try:
            # This deliberately provides normal shell syntax for a compact teaching
            # example. The README explains that cwd is not a security sandbox.
            completed = subprocess.run(
                command,
                cwd=self.root,
                env=environment,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            stdout = _coerce_subprocess_output(error.stdout)
            stderr = _coerce_subprocess_output(error.stderr)
            raise WorkspaceError(
                f"Shell command timed out after {timeout_seconds} seconds. "
                f"Partial stdout: {_clip(stdout)} Partial stderr: {_clip(stderr)}"
            ) from error

        stdout, stdout_truncated = _clip_with_status(completed.stdout)
        stderr, stderr_truncated = _clip_with_status(completed.stderr)
        return {
            "exit_code": completed.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "output_truncated": stdout_truncated or stderr_truncated,
        }

    def execute(self, name: str, arguments: Mapping[str, Any]) -> str:
        """Dispatch a model-requested tool and serialize its result."""
        try:
            if name == "read_file":
                result = self.read_file(
                    path=_argument_string(arguments, "path"),
                    offset=_argument_int(arguments, "offset", default=1),
                    limit=_argument_int(arguments, "limit", default=400),
                )
            elif name == "write_file":
                result = self.write_file(
                    path=_argument_string(arguments, "path"),
                    content=_argument_string(arguments, "content", allow_empty=True),
                )
            elif name == "edit_file":
                result = self.edit_file(
                    path=_argument_string(arguments, "path"),
                    old_text=_argument_string(arguments, "old_text"),
                    new_text=_argument_string(arguments, "new_text", allow_empty=True),
                    replace_all=_argument_bool(arguments, "replace_all", default=False),
                )
            elif name == "list_files":
                result = self.list_files(
                    pattern=_argument_string(arguments, "pattern", default="**/*")
                )
            elif name == "shell":
                result = self.run_shell(
                    command=_argument_string(arguments, "command"),
                    timeout_seconds=_argument_int(arguments, "timeout_seconds", default=30),
                )
            else:
                raise WorkspaceError(f"Unknown tool: {name}")
        except (OSError, WorkspaceError) as error:
            return json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)

        return json.dumps({"ok": True, **result}, ensure_ascii=False)

    def _resolve_path(self, path: str) -> Path:
        path = _required_string("path", path)
        requested = Path(path)
        if requested.is_absolute() or ".." in requested.parts:
            raise WorkspaceError("Paths must stay relative to the workspace.")

        resolved = (self.root / requested).resolve(strict=False)
        if not self._contains(resolved):
            raise WorkspaceError(f"Path escapes the workspace: {path}")
        return resolved

    def _contains(self, path: Path) -> bool:
        try:
            path.relative_to(self.root)
        except ValueError:
            return False
        return True

    def _display_path(self, path: Path) -> str:
        relative = path.relative_to(self.root)
        return relative.as_posix() or "."

    @staticmethod
    def _require_regular_file(path: Path) -> None:
        if not path.exists():
            raise WorkspaceError(f"File does not exist: {path}")
        if not path.is_file():
            raise WorkspaceError(f"Path is not a regular file: {path}")


TOOL_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {
        "name": "read_file",
        "description": (
            "Read a UTF-8 text file inside the workspace. Paths must be relative "
            "to the workspace root."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative file path."},
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "One-based first line to return. Defaults to 1.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_READ_LINES,
                    "description": "Maximum lines to return. Defaults to 400.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_file",
        "description": (
            "Create or completely replace a UTF-8 text file inside the workspace. "
            "Prefer edit_file for small changes to existing files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative file path."},
                "content": {"type": "string", "description": "Complete new file content."},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Replace exact text in a UTF-8 file inside the workspace. By default "
            "the old text must occur exactly once."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative file path."},
                "old_text": {"type": "string", "description": "Exact text to replace."},
                "new_text": {"type": "string", "description": "Replacement text."},
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace every match instead of requiring one match.",
                },
            },
            "required": ["path", "old_text", "new_text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_files",
        "description": (
            "List workspace files and directories using a relative glob such as "
            "'*.py', 'src/**', or '**/*.md'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Workspace-relative glob. Defaults to '**/*'.",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "shell",
        "description": (
            "Run a shell command with its process working directory set to the "
            "workspace. Use for tests, builds, and focused inspection."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run."},
                "timeout_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SHELL_TIMEOUT_SECONDS,
                    "description": "Timeout in seconds. Defaults to 30.",
                },
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
)


def build_system_prompt(workspace: Path | str) -> str:
    """Build the coding-agent instructions for one workspace."""
    root = Path(workspace).expanduser().resolve(strict=False)
    return "\n".join(
        [
            "You are a lightweight coding agent running from a terminal.",
            f"Your workspace root is: {root}",
            "Inspect relevant files before changing them and preserve unrelated work.",
            "Use only workspace-relative paths with file tools.",
            "Do not use shell commands to bypass the workspace boundary.",
            "Keep edits small and focused, then run relevant checks when practical.",
            "Avoid destructive commands and never print or search for secrets.",
            "Explain the result clearly and mention any checks you ran.",
        ]
    )


def resolve_model(cli_model: str | None, environment: Mapping[str, str] | None = None) -> str:
    """Resolve model precedence: CLI, XAI_MODEL, then the cookbook default."""
    environment = os.environ if environment is None else environment
    return cli_model or environment.get("XAI_MODEL") or DEFAULT_MODEL


class CodingAgent:
    """Stateful xAI chat plus a local client-side tool loop."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        workspace: Workspace,
        max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS,
        on_tool_call: Callable[[str, Mapping[str, Any]], None] | None = None,
    ) -> None:
        try:
            from xai_sdk import Client
            from xai_sdk.chat import system, tool, tool_result, user
        except ImportError as error:
            raise RuntimeError(
                "xai-sdk is not installed. Run `python -m pip install -e .` "
                "from this example directory."
            ) from error

        self.workspace = workspace
        self.max_tool_rounds = _bounded_int("max_tool_rounds", max_tool_rounds, minimum=1)
        self.on_tool_call = on_tool_call
        self._user_message = user
        self._tool_result = tool_result
        self._client = Client(api_key=api_key)
        tools = [
            tool(
                name=definition["name"],
                description=definition["description"],
                parameters=definition["parameters"],
            )
            for definition in TOOL_DEFINITIONS
        ]
        self._chat = self._client.chat.create(
            model=model,
            messages=[system(build_system_prompt(workspace.root))],
            tools=tools,
        )

    def run_turn(self, prompt: str) -> str:
        """Send one user turn and continue until Grok stops requesting tools."""
        prompt = _required_string("prompt", prompt)
        self._chat.append(self._user_message(prompt))
        response_text: list[str] = []

        for _ in range(self.max_tool_rounds):
            response = self._chat.sample()
            self._chat.append(response)

            if response.content:
                response_text.append(response.content)

            tool_calls = list(response.tool_calls or [])
            if not tool_calls:
                return "\n".join(response_text).strip()

            for tool_call in tool_calls:
                function = tool_call.function
                arguments, parse_error = _parse_tool_arguments(function.arguments)
                if self.on_tool_call is not None:
                    self.on_tool_call(function.name, arguments)

                if parse_error is not None:
                    result = json.dumps({"ok": False, "error": parse_error}, ensure_ascii=False)
                else:
                    result = self.workspace.execute(function.name, arguments)

                self._chat.append(self._tool_result(result, tool_call_id=tool_call.id or None))

        raise RuntimeError(f"Grok exceeded the {self.max_tool_rounds}-round tool-call limit.")


def _parse_tool_arguments(raw_arguments: str) -> tuple[dict[str, Any], str | None]:
    try:
        arguments = json.loads(raw_arguments or "{}")
    except json.JSONDecodeError as error:
        return {}, f"Tool arguments were not valid JSON: {error}"
    if not isinstance(arguments, dict):
        return {}, "Tool arguments must be a JSON object."
    return arguments, None


def _log_tool_call(name: str, arguments: Mapping[str, Any]) -> None:
    visible_keys = {
        "read_file": ("path", "offset", "limit"),
        "write_file": ("path",),
        "edit_file": ("path", "replace_all"),
        "list_files": ("pattern",),
        "shell": ("command", "timeout_seconds"),
    }.get(name, ())
    details = ", ".join(
        f"{key}={_summarize_value(arguments[key])}" for key in visible_keys if key in arguments
    )
    suffix = f"({details})" if details else "()"
    print(f"[tool] {name}{suffix}", file=sys.stderr, flush=True)


def _summarize_value(value: Any, maximum: int = 100) -> str:
    rendered = str(value).replace("\n", " ")
    if len(rendered) > maximum:
        rendered = f"{rendered[: maximum - 3]}..."
    return repr(rendered) if isinstance(value, str) else rendered


def _required_string(name: str, value: Any, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise WorkspaceError(f"{name} must be a string.")
    if not allow_empty and not value.strip():
        raise WorkspaceError(f"{name} must not be empty.")
    return value


def _required_bool(name: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise WorkspaceError(f"{name} must be a boolean.")
    return value


def _bounded_int(
    name: str,
    value: Any,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkspaceError(f"{name} must be an integer.")
    if value < minimum:
        raise WorkspaceError(f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise WorkspaceError(f"{name} must be at most {maximum}.")
    return value


def _argument_string(
    arguments: Mapping[str, Any],
    name: str,
    *,
    default: str | None = None,
    allow_empty: bool = False,
) -> str:
    if name not in arguments:
        if default is not None:
            return default
        raise WorkspaceError(f"Missing required argument: {name}")
    return _required_string(name, arguments[name], allow_empty=allow_empty)


def _argument_int(arguments: Mapping[str, Any], name: str, *, default: int) -> int:
    value = arguments.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkspaceError(f"{name} must be an integer.")
    return value


def _argument_bool(arguments: Mapping[str, Any], name: str, *, default: bool) -> bool:
    return _required_bool(name, arguments.get(name, default))


def _clip(value: str) -> str:
    return _clip_with_status(value)[0]


def _clip_with_status(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_SHELL_OUTPUT_CHARS:
        return value, False
    return f"{value[:MAX_SHELL_OUTPUT_CHARS]}\n... output truncated ...", True


def _coerce_subprocess_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a small xAI-powered coding agent in a local workspace.",
        epilog=('Example: xai-code-agent --cwd ../.. "Explain how this project is structured"'),
    )
    parser.add_argument(
        "prompt",
        nargs="*",
        help="One-shot prompt. Omit it to start the interactive REPL.",
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Workspace used by file and shell tools (default: current directory).",
    )
    parser.add_argument(
        "--model",
        help=f"xAI model override (default: XAI_MODEL or {DEFAULT_MODEL}).",
    )
    return parser


def _run_repl(agent: CodingAgent, *, model: str, workspace: Workspace) -> int:
    print(f"xAI coding agent | model: {model} | workspace: {workspace.root}")
    print("Type /help for commands.")

    while True:
        try:
            prompt = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if not prompt:
            continue
        if prompt in {"/exit", "/quit"}:
            return 0
        if prompt == "/help":
            print("/help - show commands  /exit or /quit - leave the REPL")
            continue

        try:
            response = agent.run_turn(prompt)
        except Exception as error:  # Keep the teaching REPL alive after API/tool errors.
            print(f"error: {error}", file=sys.stderr)
            continue
        print(f"grok> {response or '(no text response)'}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        workspace = Workspace(args.cwd)
    except WorkspaceError as error:
        parser.error(str(error))

    api_key = os.environ.get("XAI_API_KEY", "").strip()
    if not api_key:
        print(
            "error: XAI_API_KEY is not set. Create a key at https://console.x.ai "
            "and export it before running the agent.",
            file=sys.stderr,
        )
        return 2

    model = resolve_model(args.model)
    try:
        agent = CodingAgent(
            api_key=api_key,
            model=model,
            workspace=workspace,
            on_tool_call=_log_tool_call,
        )
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    prompt = " ".join(args.prompt).strip()
    if not prompt:
        return _run_repl(agent, model=model, workspace=workspace)

    try:
        response = agent.run_turn(prompt)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(response or "(no text response)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

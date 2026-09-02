# Grok Coding Agent CLI

A small teaching CLI that rebuilds the core coding-agent loop on the official
[xAI Python SDK](https://github.com/xai-org/xai-sdk-python). It sends prompts to
Grok, executes client-side workspace tools when requested, returns each result
to the model, and repeats until the model gives a final answer.

This is a sibling to the [Cursor Coding Agent CLI](../coding-agent-cli), but it
uses an xAI Console API key and a standalone agent loop. It is not a full
terminal UI or a replacement for a production coding agent.

## Getting Started

Use Python 3.10 or newer.

Create a virtual environment and install the example:

```bash
cd sdk/grok-coding-agent-cli
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

Create an API key at [console.x.ai](https://console.x.ai), then expose it to the
CLI:

```bash
export XAI_API_KEY="xai-..."
```

Ask for a one-shot task against the cookbook repository:

```bash
grok-code-agent --cwd ../.. "Explain how this project is structured"
```

Start the interactive REPL by omitting the prompt:

```bash
grok-code-agent --cwd ../..
```

Type `/help` for the two REPL commands, or `/exit` to quit.

## Model selection

The default model is `grok-4.6`. Override it for future models with `--model`:

```bash
grok-code-agent --model future-model "Summarize this directory"
```

You can also set `XAI_MODEL`. The precedence is `--model`, then `XAI_MODEL`,
then `grok-4.6`.

## Included tools

The model can request five local tools:

- `read_file` reads part of a UTF-8 file.
- `write_file` creates or replaces a UTF-8 file.
- `edit_file` performs an exact text replacement.
- `list_files` lists paths using a relative glob.
- `shell` runs a command with its process working directory set to `--cwd`.

File tools reject absolute paths, parent traversal, and symlink escapes. Reads,
writes, glob results, shell output, shell duration, and agent tool rounds are
bounded to keep the example understandable and avoid accidental runaway calls.
The CLI also removes `XAI_API_KEY` from the shell tool's child environment.

## Safety

This example executes model-requested writes and shell commands without an
approval prompt. `--cwd` sets the shell process's starting directory, but it is
not an operating-system sandbox: a shell command can still use absolute paths,
network access, and the permissions of the current user. Run the example only
on trusted prompts and code, preferably in a clean or disposable checkout, and
review the resulting diff.

## Offline tests

The unit tests exercise path confinement, exact edits, globbing, prompt
construction, model selection, and shell key redaction. They do not contact the
xAI API or consume credits:

```bash
python -m unittest discover -s tests -v
```

For a complete Grok coding product with a full TUI and headless mode, see the
[Grok Build documentation](https://docs.x.ai/build/overview).

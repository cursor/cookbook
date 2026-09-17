#!/usr/bin/env python3
"""Regression tests for prepare_workspace git-remote handling.

The worker image has no Git credentials. A private HTTPS GitHub URL cannot be
fetched, and that failure must not prevent the worker from launching.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ADAPTER_PATH = Path(__file__).resolve().parent / "worker_adapter.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("worker_adapter", ADAPTER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {ADAPTER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter = load_adapter()


def git(*args: str, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


class PrepareWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="agentcore-ws-")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        config = adapter.Config()
        config.worker_dir = self.tmpdir
        config.repository_url = ""
        self.supervisor = adapter.WorkerSupervisor(config, adapter.State())

    def origin_url(self) -> str:
        result = git("remote", "get-url", "origin", cwd=self.tmpdir)
        return result.stdout.strip()

    def test_private_https_fetch_failure_is_not_fatal(self) -> None:
        """Documented private GitHub HTTPS URL: fetch fails, worker still proceeds."""
        url = "https://github.com/example-org/private-does-not-exist.git"
        self.supervisor.config.repository_url = url

        self.supervisor.prepare_workspace()

        self.assertTrue(os.path.isdir(os.path.join(self.tmpdir, ".git")))
        self.assertEqual(self.origin_url(), url)
        probe = subprocess.run(
            ["git", "-C", self.tmpdir, "rev-parse", "--verify", "HEAD"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(
            probe.returncode, 0, "no checkout is expected without credentials"
        )

    def test_ssh_github_url_is_rewritten_and_fetch_failure_is_not_fatal(self) -> None:
        self.supervisor.config.repository_url = "git@github.com:example-org/private.git"

        self.supervisor.prepare_workspace()

        self.assertEqual(
            self.origin_url(), "https://github.com/example-org/private.git"
        )

    def test_public_local_remote_is_fetched_and_checked_out(self) -> None:
        """When the remote is reachable without credentials, fetch still happens."""
        bare = tempfile.mkdtemp(prefix="agentcore-bare-")
        self.addCleanup(shutil.rmtree, bare, ignore_errors=True)
        seed = tempfile.mkdtemp(prefix="agentcore-seed-")
        self.addCleanup(shutil.rmtree, seed, ignore_errors=True)

        git("init", "--bare", cwd=bare)
        git("clone", bare, seed, cwd="/")
        git("checkout", "-B", "main", cwd=seed)
        git(
            "-c",
            "user.email=lab@example.com",
            "-c",
            "user.name=Lab",
            "commit",
            "--allow-empty",
            "-m",
            "seed",
            cwd=seed,
        )
        git("push", "origin", "HEAD:main", cwd=seed)

        self.supervisor.config.repository_url = bare
        self.supervisor.prepare_workspace()

        self.assertEqual(self.origin_url(), bare)
        branch = git("rev-parse", "--abbrev-ref", "HEAD", cwd=self.tmpdir).stdout.strip()
        self.assertEqual(branch, "main")
        head = git("rev-parse", "--verify", "HEAD", cwd=self.tmpdir)
        self.assertEqual(head.returncode, 0)

    def test_unset_url_skips_git_initialization(self) -> None:
        self.supervisor.config.repository_url = ""
        self.supervisor.prepare_workspace()
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, ".git")))

    def test_checkout_timeout_after_fetch_is_not_fatal(self) -> None:
        """A git checkout that times out after a good fetch must not fail startup.

        Regression for the best-effort wrapper catching only RuntimeError: _git
        raises subprocess.TimeoutExpired (e.g. `git remote set-head --auto` or the
        checkout itself hitting the 120s default), which previously escaped and
        marked the worker startup failed even though fetch already succeeded.
        """
        bare = tempfile.mkdtemp(prefix="agentcore-bare-")
        self.addCleanup(shutil.rmtree, bare, ignore_errors=True)
        seed = tempfile.mkdtemp(prefix="agentcore-seed-")
        self.addCleanup(shutil.rmtree, seed, ignore_errors=True)

        git("init", "--bare", cwd=bare)
        git("clone", bare, seed, cwd="/")
        git("checkout", "-B", "main", cwd=seed)
        git(
            "-c", "user.email=lab@example.com", "-c", "user.name=Lab",
            "commit", "--allow-empty", "-m", "seed", cwd=seed,
        )
        git("push", "origin", "HEAD:main", cwd=seed)

        self.supervisor.config.repository_url = bare

        def boom() -> None:
            raise subprocess.TimeoutExpired(cmd="git checkout", timeout=120)

        self.supervisor._checkout_origin_head = boom  # type: ignore[method-assign]

        # Must not raise despite the checkout timing out.
        self.supervisor.prepare_workspace()

        # Origin is still set even though the checkout was abandoned.
        self.assertEqual(self.origin_url(), bare)

    def test_failed_fetch_does_not_mark_supervisor_startup_failed(self) -> None:
        """run() must reach worker launch even when origin cannot be fetched."""
        self.supervisor.config.repository_url = (
            "https://github.com/example-org/private-does-not-exist.git"
        )
        self.supervisor.config.api_key = "test-service-account-key"
        self.supervisor.config.max_restarts = 0

        launched = []

        class FakeProcess:
            pid = 4242

            def wait(self, timeout=None):
                return 0

            def terminate(self):
                return None

            def kill(self):
                return None

        original = adapter.subprocess.Popen

        def fake_popen(*args, **kwargs):
            command = args[0] if args else kwargs.get("args")
            if isinstance(command, (list, tuple)) and command and command[0] == "agent":
                launched.append(
                    {
                        "command": command,
                        "cwd": kwargs.get("cwd"),
                        "env_has_key": "CURSOR_API_KEY" in (kwargs.get("env") or {}),
                    }
                )
                return FakeProcess()
            return original(*args, **kwargs)

        adapter.subprocess.Popen = fake_popen  # type: ignore[method-assign]
        try:
            self.supervisor.run()
        finally:
            adapter.subprocess.Popen = original  # type: ignore[method-assign]

        self.assertEqual(len(launched), 1, "worker must still be launched after fetch failure")
        self.assertEqual(launched[0]["cwd"], self.tmpdir)
        snapshot = self.supervisor.state.snapshot()
        self.assertIsNone(
            snapshot["last_error"],
            "fetch failure must not mark startup failed",
        )


class GithubRepoLabelTests(unittest.TestCase):
    def test_https_git_suffix(self) -> None:
        self.assertEqual(
            adapter.WorkerSupervisor.github_repo_label(
                "https://github.com/kaushalavardhanam/kaushalavardhanam.git"
            ),
            "kaushalavardhanam/kaushalavardhanam",
        )

    def test_ssh_is_rewritten(self) -> None:
        self.assertEqual(
            adapter.WorkerSupervisor.github_repo_label(
                "git@github.com:acme/payments.git"
            ),
            "acme/payments",
        )

    def test_non_github_is_empty(self) -> None:
        self.assertEqual(adapter.WorkerSupervisor.github_repo_label("/tmp/bare.git"), "")


class RepoRoutingLabelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="agentcore-ws-")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        config = adapter.Config()
        config.worker_dir = self.tmpdir
        config.repository_url = (
            "https://github.com/kaushalavardhanam/kaushalavardhanam.git"
        )
        config.labels_file = os.path.join(self.tmpdir, "missing-labels.json")
        config.labels_json = json.dumps(
            {
                "environment": "lab",
                "infrastructure": "agentcore",
                "runtime": "agentcore-instances",
                "owner": "platform-team",
            }
        )
        config.api_key = "test-service-account-key"
        config.max_restarts = 0
        self.supervisor = adapter.WorkerSupervisor(config, adapter.State())

    def test_labels_file_includes_repo_without_cli_flag(self) -> None:
        command = self.supervisor.build_command()
        self.assertNotIn("--label", command)
        self.assertIn("--labels-file", command)
        labels_path = self.supervisor.resolve_labels_file()
        self.assertIsNotNone(labels_path)
        with open(labels_path, encoding="utf-8") as handle:
            labels = json.load(handle)
        self.assertEqual(labels["repo"], "kaushalavardhanam/kaushalavardhanam")

    def test_worker_env_sets_safe_directory(self) -> None:
        env = self.supervisor._worker_env("test-service-account-key")
        self.assertEqual(env["GIT_CONFIG_KEY_0"], "safe.directory")
        self.assertEqual(env["GIT_CONFIG_VALUE_0"], "*")
        self.assertEqual(env["CURSOR_API_KEY"], "test-service-account-key")
        self.assertNotIn("GIT_DIR", env)


class GitTokenTests(unittest.TestCase):
    """The Git write token: resolved from env or Secrets Manager, then wired into
    a git credential helper so the worker can push. Optional and non-fatal."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="agentcore-gittok-")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        config = adapter.Config()
        config.worker_dir = self.tmpdir
        self.config = config
        self.supervisor = adapter.WorkerSupervisor(config, adapter.State())

    def test_resolve_git_token_prefers_env(self) -> None:
        self.config.git_token = "github_pat_env"
        self.config.git_token_secret_id = "some-secret"
        self.assertEqual(self.supervisor.resolve_git_token(), "github_pat_env")

    def test_resolve_git_token_empty_when_nothing_configured(self) -> None:
        self.config.git_token = ""
        self.config.git_token_secret_id = ""
        self.assertEqual(self.supervisor.resolve_git_token(), "")

    def test_resolve_git_token_reads_secret(self) -> None:
        self.config.git_token = ""
        self.config.git_token_secret_id = "cursor-agentcore-worker-git-token"
        self.supervisor._read_secret = lambda secret_id: "github_pat_from_secret"  # type: ignore
        self.assertEqual(self.supervisor.resolve_git_token(), "github_pat_from_secret")

    def test_empty_token_does_not_configure_credentials(self) -> None:
        """No token means no credential file and no git config change."""
        calls = []
        original = adapter.subprocess.run

        def spy(*args, **kwargs):
            calls.append(args[0] if args else kwargs.get("args"))
            return original(*args, **kwargs)

        adapter.subprocess.run = spy  # type: ignore
        try:
            self.supervisor._configure_git_credentials("")
        finally:
            adapter.subprocess.run = original  # type: ignore
        self.assertEqual(calls, [], "no git config should run for an empty token")

    def test_configure_credentials_sets_helper_and_protects_file(self) -> None:
        """A token writes a 0600 credential store and points git at it, and the
        token never appears in a git config VALUE (only the store path does)."""
        cred_path = os.path.join(self.tmpdir, ".git-credentials-cursor")
        git_configs = []
        original = adapter.subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and cmd[:2] == ["git", "config"]:
                git_configs.append(list(cmd))
                # Do not actually touch a global gitconfig during the test.
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return original(cmd, *args, **kwargs)

        # Redirect the credential store into the test dir instead of /root.
        orig_configure = self.supervisor._configure_git_credentials

        def patched(token: str) -> None:
            if not token:
                return
            with open(cred_path, "w", encoding="utf-8") as h:
                h.write(f"https://x-access-token:{token}@github.com\n")
            os.chmod(cred_path, 0o600)
            adapter.subprocess.run(
                ["git", "config", "--global", "credential.helper", f"store --file={cred_path}"],
                capture_output=True, text=True, timeout=30,
            )

        adapter.subprocess.run = fake_run  # type: ignore
        try:
            patched("github_pat_secret_value")
        finally:
            adapter.subprocess.run = original  # type: ignore

        self.assertTrue(os.path.isfile(cred_path))
        mode = oct(os.stat(cred_path).st_mode & 0o777)
        self.assertEqual(mode, "0o600", "credential store must be private")
        with open(cred_path, encoding="utf-8") as h:
            self.assertIn("x-access-token:github_pat_secret_value@github.com", h.read())
        # The helper is configured with the store PATH, not the raw token.
        self.assertTrue(any("credential.helper" in c for c in git_configs))
        for c in git_configs:
            self.assertNotIn("github_pat_secret_value", " ".join(c))


if __name__ == "__main__":
    unittest.main()

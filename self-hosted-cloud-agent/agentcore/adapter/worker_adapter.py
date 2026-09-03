#!/usr/bin/env python3
"""AgentCore Runtime adapter for a Cursor self-hosted pool worker.

AgentCore Runtime requires an HTTP server on 0.0.0.0:8080 exposing GET /ping and
POST /invocations. A Cursor pool worker is the opposite shape: a long-lived process that
dials Cursor outbound and never serves a request. This adapter bridges the two.

It runs as PID 1, forks `agent worker --pool ... start` as a child, and reports
`HealthyBusy` on /ping for as long as that child is alive. Per the AgentCore HTTP protocol
contract, a session reporting `HealthyBusy` is kept alive past the 15-minute idle timeout,
so the ping status is the keepalive mechanism. There is no separate keepalive API.

Two documented footguns are handled deliberately:

  1. `time_of_last_update` is set only on an actual status transition. A timestamp that
     advances on every ping signals continuous change, which prevents the idle timeout from
     ever firing and leaks sessions until MaxLifetime.
  2. The ping path never blocks. Health is served from a snapshot taken under a short lock
     while the child is supervised on a separate thread. A blocked ping thread is the
     documented cause of sessions dying at exactly 15 minutes.

Standard library only, so the worker image needs no extra dependencies.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The two status values the AgentCore /ping contract defines. Nothing else is valid.
STATUS_HEALTHY = "Healthy"
STATUS_HEALTHY_BUSY = "HealthyBusy"

# AgentCore passes the session ID in this header. No environment variable carries it.
SESSION_ID_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"

MAX_REQUEST_BYTES = 1 << 20


def log(message: str) -> None:
    """Write a line to stdout so it reaches CloudWatch runtime-logs."""
    sys.stdout.write(f"[adapter] {message}\n")
    sys.stdout.flush()


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"{name}={raw!r} is not an integer, using {default}")
        return default


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


class Config:
    """Environment contract, kept compatible with the sibling ec2/ecs targets."""

    def __init__(self) -> None:
        self.port = env_int("AGENTCORE_ADAPTER_PORT", 8080)
        self.bind = os.environ.get("AGENTCORE_ADAPTER_BIND", "0.0.0.0")

        # Mount paths for capacity provider volumes must be under /mnt with exactly one
        # subdirectory level, so this diverges from the sibling default of /workspace.
        self.worker_dir = os.environ.get("CURSOR_WORKER_DIR", "/mnt/workspace")
        self.pool_name = os.environ.get("CURSOR_WORKER_POOL_NAME", "agentcore-lab")
        self.idle_release_timeout = os.environ.get(
            "CURSOR_WORKER_IDLE_RELEASE_TIMEOUT", "600"
        )
        self.labels_file = os.environ.get(
            "CURSOR_WORKER_LABELS_FILE", "/etc/cursor/labels.json"
        )
        self.labels_json = os.environ.get("CURSOR_WORKER_LABELS_JSON", "")
        self.management_addr = os.environ.get("CURSOR_WORKER_MANAGEMENT_ADDR", "")
        self.repository_url = os.environ.get("WORKER_REPOSITORY_URL", "")

        # AgentCore has no native secret injection, so the key is fetched at startup with
        # the runtime execution role rather than delivered as a task secret.
        self.api_key = os.environ.get("CURSOR_API_KEY", "")
        self.api_key_secret_id = os.environ.get("CURSOR_API_KEY_SECRET_ID", "")
        self.aws_region = (
            os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
            or "us-west-2"
        )

        self.max_restarts = env_int("AGENTCORE_WORKER_MAX_RESTARTS", 5)
        self.restart_backoff = env_int("AGENTCORE_WORKER_RESTART_BACKOFF_SECONDS", 10)

        # On permanent worker failure the default is to report Healthy, which makes the
        # session idle-eligible and reaped after the documented 15 minutes. Reporting
        # unhealthy is faster but the unhealthy threshold is undocumented, so it is opt-in.
        self.unhealthy_on_failure = env_bool("AGENTCORE_UNHEALTHY_ON_FAILURE", False)


class State:
    """Health state shared between the supervisor thread and the HTTP handlers.

    Only `snapshot()` is called on the ping path. It takes the lock briefly and copies
    primitives, so a stalled worker can never block a health check.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status = STATUS_HEALTHY
        self._status_changed_at = int(time.time())
        self._started_at = int(time.time())
        self._worker_pid: int | None = None
        self._restarts = 0
        self._last_exit_code: int | None = None
        self._last_error: str | None = None
        self._permanently_failed = False
        self._session_id: str | None = None

    def _set_status(self, status: str) -> None:
        """Update status, advancing the change timestamp only on a real transition."""
        if status == self._status:
            return
        self._status = status
        self._status_changed_at = int(time.time())
        log(f"status -> {status}")

    def mark_worker_running(self, pid: int) -> None:
        with self._lock:
            self._worker_pid = pid
            self._permanently_failed = False
            self._last_error = None
            self._set_status(STATUS_HEALTHY_BUSY)

    def mark_worker_exited(
        self, exit_code: int | None, restarting: bool, permanent: bool = True
    ) -> None:
        """Record a worker exit.

        `permanent` is False for an exit caused by our own shutdown: that is not a failure,
        and marking it as one would hold the health endpoint open instead of exiting.
        """
        with self._lock:
            self._worker_pid = None
            self._last_exit_code = exit_code
            if restarting:
                self._restarts += 1
                return
            self._permanently_failed = permanent
            self._set_status(STATUS_HEALTHY)

    def mark_failed(self, error: str) -> None:
        with self._lock:
            self._worker_pid = None
            self._last_error = error
            self._permanently_failed = True
            self._set_status(STATUS_HEALTHY)

    def record_session_id(self, session_id: str) -> None:
        with self._lock:
            if session_id and self._session_id != session_id:
                self._session_id = session_id

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "status": self._status,
                "status_changed_at": self._status_changed_at,
                "started_at": self._started_at,
                "worker_pid": self._worker_pid,
                "restarts": self._restarts,
                "last_exit_code": self._last_exit_code,
                "last_error": self._last_error,
                "permanently_failed": self._permanently_failed,
                "session_id": self._session_id,
            }


class WorkerSupervisor:
    """Prepares the workspace, then runs and restarts the Cursor worker process."""

    def __init__(self, config: Config, state: State) -> None:
        self.config = config
        self.state = state
        self._process: subprocess.Popen | None = None
        self._process_lock = threading.Lock()
        self._stop = threading.Event()
        self._restart_requested = threading.Event()

    # -- setup ------------------------------------------------------------------

    def resolve_api_key(self) -> str:
        """Return the Cursor API key, fetching it from Secrets Manager if needed.

        Uses the AWS CLI already present in the worker image rather than adding boto3, and
        mirrors how the EC2 target reads the secret during bootstrap.
        """
        if self.config.api_key:
            log("using CURSOR_API_KEY from the environment")
            return self.config.api_key

        secret_id = self.config.api_key_secret_id
        if not secret_id:
            raise RuntimeError(
                "Set CURSOR_API_KEY or CURSOR_API_KEY_SECRET_ID. The key must be a Cursor "
                "service account API key; user, team, personal, and organization keys are "
                "rejected for pool workers."
            )

        log(f"fetching the Cursor API key from Secrets Manager: {secret_id}")
        result = subprocess.run(
            [
                "aws", "secretsmanager", "get-secret-value",
                "--region", self.config.aws_region,
                "--secret-id", secret_id,
                "--query", "SecretString",
                "--output", "text",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"could not read secret {secret_id}: {result.stderr.strip()}"
            )

        api_key = result.stdout.strip()
        if not api_key or api_key == "None":
            raise RuntimeError(
                f"secret {secret_id} is empty. Upload the service account key first."
            )
        return api_key

    def prepare_workspace(self) -> None:
        """Create the worker directory and give it a git origin.

        Cursor derives the repo label from this remote and worker startup fails without it.
        This must be idempotent because the EBS volume persists across session restarts and
        will already be initialized on the second start.
        """
        worker_dir = self.config.worker_dir
        os.makedirs(worker_dir, exist_ok=True)

        url = self.config.repository_url
        if not url:
            log("WORKER_REPOSITORY_URL is unset, skipping git initialization")
            return

        if not os.path.isdir(os.path.join(worker_dir, ".git")):
            log(f"initializing {worker_dir} as a git repository")
            subprocess.run(
                ["git", "init", "--initial-branch=main", worker_dir],
                check=True, capture_output=True, text=True,
            )

        # Remove then add, so a persisted volume with a stale remote converges.
        subprocess.run(
            ["git", "-C", worker_dir, "remote", "remove", "origin"],
            capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", worker_dir, "remote", "add", "origin", url],
            check=True, capture_output=True, text=True,
        )
        log(f"git origin set to {url}")

    def resolve_labels_file(self) -> str | None:
        """Write CURSOR_WORKER_LABELS_JSON to a file if provided, else use the baked file."""
        if self.config.labels_json:
            path = "/tmp/cursor-worker-labels.json"
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(self.config.labels_json)
            return path
        if os.path.isfile(self.config.labels_file):
            return self.config.labels_file
        return None

    def build_command(self) -> list[str]:
        """Build the worker command.

        Worker options must appear BEFORE the `start` subcommand. The CLI rejects them
        otherwise, which is a documented failure mode in the sibling targets.
        """
        args = [
            "agent", "worker",
            "--pool",
            "--pool-name", self.config.pool_name,
            "--worker-dir", self.config.worker_dir,
            "--idle-release-timeout", str(self.config.idle_release_timeout),
        ]

        labels_file = self.resolve_labels_file()
        if labels_file:
            args += ["--labels-file", labels_file]
        if self.config.management_addr:
            args += ["--management-addr", self.config.management_addr]

        args.append("start")
        return args

    # -- supervision ------------------------------------------------------------

    def run(self) -> None:
        """Supervise the worker until told to stop or the restart budget is spent."""
        try:
            api_key = self.resolve_api_key()
            self.prepare_workspace()
        except Exception as exc:  # noqa: BLE001 - surface any setup failure as health state
            log(f"startup failed: {exc}")
            self.state.mark_failed(str(exc))
            return

        worker_env = os.environ.copy()
        worker_env["CURSOR_API_KEY"] = api_key

        command = self.build_command()
        log("worker command: " + " ".join(command))

        attempt = 0
        while not self._stop.is_set():
            self._restart_requested.clear()
            try:
                process = subprocess.Popen(command, env=worker_env)  # noqa: S603
            except Exception as exc:  # noqa: BLE001
                log(f"could not start the worker: {exc}")
                self.state.mark_failed(str(exc))
                return

            with self._process_lock:
                self._process = process

            self.state.mark_worker_running(process.pid)
            log(f"worker started, pid {process.pid}, pool {self.config.pool_name!r}")

            exit_code = process.wait()

            with self._process_lock:
                self._process = None

            if self._stop.is_set():
                log(f"worker exited with {exit_code} during shutdown")
                self.state.mark_worker_exited(
                    exit_code, restarting=False, permanent=False
                )
                return

            if self._restart_requested.is_set():
                log("worker restart requested via /invocations")
                self.state.mark_worker_exited(exit_code, restarting=True)
                continue

            attempt += 1
            if attempt > self.config.max_restarts:
                log(
                    f"worker exited with {exit_code}; restart budget of "
                    f"{self.config.max_restarts} is spent, giving up"
                )
                self.state.mark_worker_exited(exit_code, restarting=False)
                return

            backoff = self.config.restart_backoff * attempt
            log(
                f"worker exited with {exit_code}; restarting in {backoff}s "
                f"(attempt {attempt}/{self.config.max_restarts})"
            )
            self.state.mark_worker_exited(exit_code, restarting=True)
            self._stop.wait(backoff)

    def request_restart(self) -> bool:
        with self._process_lock:
            process = self._process
            if process is None:
                return False
            self._restart_requested.set()
            process.terminate()
            return True

    def shutdown(self) -> None:
        self._stop.set()
        with self._process_lock:
            process = self._process
        if process is None:
            return
        log("stopping the worker")
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            log("worker did not exit in 30s, killing it")
            process.kill()


class Handler(BaseHTTPRequestHandler):
    """Implements the AgentCore HTTP protocol contract."""

    protocol_version = "HTTP/1.1"
    config: Config
    state: State
    supervisor: WorkerSupervisor

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        """Suppress per-request logs for the health path, which is polled continuously."""
        if self.path == "/ping":
            return
        log("http " + fmt % args)

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _capture_session_id(self) -> str | None:
        session_id = self.headers.get(SESSION_ID_HEADER)
        if session_id:
            self.state.record_session_id(session_id)
        return session_id

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path in ("/ping", "/healthz"):
            self._handle_ping()
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/invocations":
            self._handle_invocations()
            return
        self._send_json(404, {"error": "not found"})

    def _handle_ping(self) -> None:
        """Return the health status. Must stay non-blocking and allocation-light."""
        snapshot = self.state.snapshot()

        if snapshot["permanently_failed"] and self.config.unhealthy_on_failure:
            self._send_json(503, {
                "status": snapshot["status"],
                "detail": "the worker stopped permanently",
            })
            return

        # `time_of_last_update` reflects the last real transition. It must not advance on
        # every ping, or the idle timeout never fires and sessions leak until MaxLifetime.
        self._send_json(200, {
            "status": snapshot["status"],
            "time_of_last_update": snapshot["status_changed_at"],
        })

    def _handle_invocations(self) -> None:
        """Report or steer the worker.

        The contract requires this endpoint, and a session only comes into existence when
        InvokeAgentRuntime is called, so this is also what boots a worker.
        """
        session_id = self._capture_session_id()

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "payload too large"})
            return

        action = "status"
        if length:
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw or b"{}")
                if isinstance(payload, dict):
                    action = str(payload.get("action") or "status")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "body must be JSON"})
                return

        if action == "restart":
            restarted = self.supervisor.request_restart()
            self._send_json(200 if restarted else 409, {
                "action": "restart",
                "accepted": restarted,
                "detail": "restarting" if restarted else "no worker is running",
            })
            return

        if action == "stop":
            threading.Thread(target=self.supervisor.shutdown, daemon=True).start()
            self._send_json(202, {"action": "stop", "accepted": True})
            return

        if action != "status":
            self._send_json(400, {
                "error": f"unknown action {action!r}",
                "supported": ["status", "restart", "stop"],
            })
            return

        snapshot = self.state.snapshot()
        now = int(time.time())
        self._send_json(200, {
            "status": snapshot["status"],
            "worker": {
                "running": snapshot["worker_pid"] is not None,
                "pid": snapshot["worker_pid"],
                "pool_name": self.config.pool_name,
                "worker_dir": self.config.worker_dir,
                "restarts": snapshot["restarts"],
                "last_exit_code": snapshot["last_exit_code"],
                "last_error": snapshot["last_error"],
                "permanently_failed": snapshot["permanently_failed"],
            },
            "session": {
                "id": session_id or snapshot["session_id"],
                "uptime_seconds": now - snapshot["started_at"],
            },
        })


def main() -> int:
    config = Config()
    state = State()
    supervisor = WorkerSupervisor(config, state)

    Handler.config = config
    Handler.state = state
    Handler.supervisor = supervisor

    # Start the HTTP listener before the worker so /ping answers immediately. AgentCore may
    # probe as soon as the container is up, and an unanswered probe risks a 424.
    server = ThreadingHTTPServer((config.bind, config.port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"listening on {config.bind}:{config.port}")

    def handle_signal(signum, _frame) -> None:
        log(f"received signal {signum}, shutting down")
        supervisor.shutdown()
        server.shutdown()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # The supervisor runs on the main thread so the process exits when it returns.
    supervisor.run()

    snapshot = state.snapshot()
    if snapshot["permanently_failed"]:
        # Keep serving /ping as Healthy so AgentCore reaps the session on the idle timeout
        # instead of the container dying and surfacing as an opaque invocation error.
        log("the worker stopped permanently; holding the health endpoint open")
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            pass
        return 1

    log("adapter exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())

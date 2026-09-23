"""Invoke the rewind CLI and hand back the JSON it printed.

The UI is a client of the CLI, not a reimplementation of it: every panel is drawn from
the same ``--output json`` document a terminal user would get, produced by calling
``rewind.cli.main`` with the same argv. The exact argv is returned alongside the payload
so the UI can show it.

Two modes:

``live``
    No injection at all. ``main`` builds its own CloudTrail and boto3 clients from the
    ambient AWS configuration, exactly as the installed ``rewind`` command does.

``demo``
    A sanitized CloudTrail fixture stands in for the event source, and an in-memory fake
    account stands in for the read and write APIs. Nothing leaves the machine. The fake
    account is *stateful*, so a revert in the UI really does move it and a later plan or
    diff sees the moved state.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

CLI_ROOT = Path(__file__).resolve().parents[2] / "aws-rewind-cli"


def _ensure_importable() -> None:
    """Put the CLI package and its test helpers on the path.

    The fixture and the fake account live in the CLI's ``tests/`` directory. Demo mode
    reuses them rather than keeping a second copy that could drift.
    """
    for path in (CLI_ROOT / "src", CLI_ROOT / "tests"):
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)


_ensure_importable()

from rewind import cli as cli_module  # noqa: E402
from rewind.cloudtrail import StaticEventSource  # noqa: E402

FIXTURE = "agent_session.json"


class CliError(RuntimeError):
    def __init__(self, exit_code: int, message: str, argv: List[str]) -> None:
        super().__init__(message or "rewind exited %d" % exit_code)
        self.exit_code = exit_code
        self.argv = argv


class DemoWorld:
    """The fixture session plus the fake account it left behind.

    Held for the life of the server process so the demo has continuity: scan, plan,
    diff, revert and a second diff all see one account.
    """

    def __init__(self) -> None:
        _ensure_importable()
        from conftest import live_world_after_session, load_fixture

        self.fixture = load_fixture(FIXTURE)
        self.world = live_world_after_session()
        # The single mutating path has to be allowed for `revert --confirm` to mean
        # anything in the demo; the fake refuses writes from read-only paths itself.
        self.world.allow_writes = True

    def reset(self) -> None:
        from conftest import live_world_after_session

        self.world = live_world_after_session()
        self.world.allow_writes = True

    @property
    def identity(self) -> str:
        return self.fixture.identity

    @property
    def region(self) -> str:
        return self.fixture.region

    @property
    def now(self):
        """The fixture's window end, so `--since` windows line up with its events."""
        return self.fixture.end_time

    def source(self) -> StaticEventSource:
        return self.fixture.source()

    def tamper(self) -> Dict[str, str]:
        """Have a third party change a field the session also touched.

        This is what makes ``diff`` earn its place in a demo: the plan is now stale for
        that field, and reverting it would overwrite work that is not the agent's.
        """
        from conftest import INSTANCE_A

        self.world.instance_types[INSTANCE_A] = "t3.xlarge"
        return {"resource": INSTANCE_A, "field": "instanceType", "value": "t3.xlarge"}

    def state(self) -> Dict[str, Any]:
        """Live field values, for the UI's account-state strip."""
        world = self.world
        fields = []
        for instance_id, value in sorted(world.instance_types.items()):
            fields.append({"resource": instance_id, "field": "instanceType", "value": value})
        for instance_id, value in sorted(world.monitoring.items()):
            fields.append({"resource": instance_id, "field": "monitoring", "value": value})
        for alias, value in sorted(world.concurrency.items()):
            fields.append(
                {"resource": alias, "field": "provisionedConcurrency", "value": str(value)}
            )
        for identifier, value in sorted(world.multi_az.items()):
            fields.append(
                {
                    "resource": identifier,
                    "field": "multiAZ",
                    "value": "true" if value else "false",
                }
            )
        return {"fields": fields, "writes": world.write_api_names()}


def run(argv: List[str], demo: Optional[DemoWorld] = None) -> Dict[str, Any]:
    """Run one rewind command and return ``{argv, exitCode, payload}``.

    ``argv`` is returned as the caller passed it, because that string is what the UI
    displays and it must stay honest about what was executed.
    """
    full_argv = list(argv)
    if "--output" not in full_argv:
        full_argv += ["--output", "json"]

    out, err = io.StringIO(), io.StringIO()
    original_source = cli_module._source
    original_clients = cli_module._clients
    now = None

    if demo is not None:
        now = demo.now
        cli_module._source = lambda region, args: demo.source()
        cli_module._clients = lambda region, args: demo.world

    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exit_code = cli_module.main(full_argv, now=now)
    except SystemExit as exit_signal:  # argparse usage errors
        exit_code = int(exit_signal.code or 0)
    finally:
        cli_module._source = original_source
        cli_module._clients = original_clients

    stdout, stderr = out.getvalue(), err.getvalue()
    try:
        payload = json.loads(stdout) if stdout.strip() else None
    except json.JSONDecodeError:
        payload = None

    # `diff --exit-code` uses 3 to mean "conflicts found", which is a successful run.
    ok = exit_code in (cli_module.EXIT_OK, cli_module.EXIT_CONFLICT)
    if not ok and payload is None:
        raise CliError(exit_code, stderr.strip() or stdout.strip(), full_argv)

    return {
        "argv": ["rewind"] + full_argv,
        "exitCode": exit_code,
        "payload": payload,
        "stderr": stderr.strip(),
    }

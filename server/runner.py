"""Invoke the rewind CLI in live mode and hand back the JSON it printed.

The UI is a client of the CLI, not a reimplementation of it: every panel is drawn from the
same ``--output json`` document a terminal user would get, produced by calling
``rewind.cli.main`` with the same argv. The exact argv is returned alongside the payload so
the UI can show it. Nothing is injected here - ``main`` builds its own CloudTrail and boto3
clients from the ambient AWS configuration, exactly as the installed ``rewind`` command
does.

Demo mode does not come through this module at all: it replays a recorded real session,
see ``transcript.py``. The CLI is therefore imported lazily, on the first live command, so
that a checkout of this repo alone can serve the demo without the CLI beside it.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

CLI_ROOT = Path(__file__).resolve().parents[2] / "aws-rewind-cli"


def _cli():
    """The ``rewind.cli`` module, imported on first use.

    Live mode needs the CLI package; demo mode does not, and this repo is published without
    it. So the import happens here rather than at module scope, and says what is missing.
    """
    for path in (CLI_ROOT / "src",):
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)
    try:
        from rewind import cli as cli_module
    except ImportError as error:
        raise CliError(
            2,
            "live mode needs the rewind CLI: expected it at %s (%s). Clone aws-rewind-cli "
            "beside this repo, or use --mode demo." % (CLI_ROOT, error),
            ["rewind"],
        ) from error
    return cli_module


class CliError(RuntimeError):
    def __init__(self, exit_code: int, message: str, argv: List[str]) -> None:
        super().__init__(message or "rewind exited %d" % exit_code)
        self.exit_code = exit_code
        self.argv = argv


def run(argv: List[str]) -> Dict[str, Any]:
    """Run one rewind command and return ``{argv, exitCode, payload, raw}``.

    ``argv`` is returned as the caller passed it, because that string is what the UI
    displays and it must stay honest about what was executed.
    """
    cli_module = _cli()
    full_argv = list(argv)
    if "--output" not in full_argv:
        full_argv += ["--output", "json"]

    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exit_code = cli_module.main(full_argv)
    except SystemExit as exit_signal:  # argparse usage errors
        exit_code = int(exit_signal.code or 0)

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
        "raw": stdout.strip(),
        "stderr": stderr.strip(),
    }

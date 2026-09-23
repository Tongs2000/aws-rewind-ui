"""A single-process HTTP front end for the rewind CLI.

Stdlib only: no framework, no build step, no new dependency on the CLI package. Start it
with ``python server/app.py`` and open the printed URL.

Every ``/api`` route is a thin wrapper around one rewind command. The response always
carries the argv that was executed and the raw JSON document that came back, so the UI
can show both and never has to be trusted on its own.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import CliError, DemoWorld, run  # noqa: E402

STATIC = Path(__file__).resolve().parents[1] / "web"
DEFAULT_SINCE = "90m"


class Session:
    """Server-side state: the mode, the demo account, and the current plan file.

    ``plan`` and ``revert`` in the CLI communicate through a plan file on disk. The UI
    keeps that contract rather than passing plans around in memory, so what `diff` and
    `revert` read is exactly what a terminal user would have written with ``-o``.
    """

    def __init__(self, mode: str, identity: Optional[str], region: Optional[str]) -> None:
        self.mode = mode
        self.lock = threading.Lock()
        self.demo: Optional[DemoWorld] = DemoWorld() if mode == "demo" else None
        self.identity = identity or (self.demo.identity if self.demo else "")
        self.region = region or (self.demo.region if self.demo else "")
        self.plan_dir = tempfile.mkdtemp(prefix="rewind-ui-")
        self.plan_path = os.path.join(self.plan_dir, "plan.json")

    def window_args(self, body: Dict[str, Any]) -> List[str]:
        identity = (body.get("identity") or self.identity).strip()
        region = (body.get("region") or self.region).strip()
        since = (body.get("since") or DEFAULT_SINCE).strip()
        argv = ["--identity", identity, "--since", since]
        if region:
            argv += ["--region", region]
        return argv

    def call(self, argv: List[str]) -> Dict[str, Any]:
        return run(argv, self.demo)

    def has_plan(self) -> bool:
        return os.path.exists(self.plan_path)

    def describe(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "identity": self.identity,
            "region": self.region,
            "since": DEFAULT_SINCE,
            "planPath": self.plan_path if self.has_plan() else None,
            "now": self.demo.now.isoformat() if self.demo else None,
            "account": self.demo.state() if self.demo else None,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "rewind-ui"
    session: Session  # set on the server instance below

    # -- plumbing -----------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    # -- static -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/session":
            return self._json(200, self.session.describe())
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (STATIC / name).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            return self._json(404, {"error": "not found: %s" % path})
        kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), kind)

    # -- api ----------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?", 1)[0]
        body = self._body()
        session = self.session
        try:
            with session.lock:
                handler = {
                    "/api/scan": self._scan,
                    "/api/plan": self._plan,
                    "/api/diff": self._diff,
                    "/api/revert": self._revert,
                    "/api/resolvers": self._resolvers,
                    "/api/reset": self._reset,
                    "/api/tamper": self._tamper,
                }.get(route)
                if handler is None:
                    return self._json(404, {"error": "no such route: %s" % route})
                result = handler(session, body)
        except CliError as error:
            return self._json(
                400,
                {
                    "error": str(error),
                    "argv": ["rewind"] + error.argv,
                    "exitCode": error.exit_code,
                },
            )
        except Exception as error:  # pragma: no cover - surfaced in the UI instead
            traceback.print_exc()
            return self._json(500, {"error": "%s: %s" % (type(error).__name__, error)})
        result["account"] = session.demo.state() if session.demo else None
        self._json(200, result)

    def _scan(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        return session.call(["scan"] + session.window_args(body))

    def _plan(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        argv = ["plan"] + session.window_args(body) + ["-o", session.plan_path]
        for assignment in body.get("sets") or []:
            selector = str(assignment.get("selector") or "").strip()
            value = str(assignment.get("value") or "").strip()
            if selector and value:
                argv += ["--set", "%s=%s" % (selector, value)]
        if body.get("useConfig"):
            argv.append("--use-config")
        return session.call(argv)

    def _diff(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if not session.has_plan():
            raise CliError(2, "no plan yet: run plan first", ["diff"])
        argv = ["diff", session.plan_path]
        if body.get("blame"):
            argv.append("--blame")
        return session.call(argv)

    def _revert(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if not session.has_plan():
            raise CliError(2, "no plan yet: run plan first", ["revert"])
        argv = ["revert", session.plan_path]
        if body.get("confirm"):
            argv.append("--confirm")
        for chain_id in body.get("only") or []:
            argv += ["--only", str(chain_id)]
        if session.demo is not None:
            # The fake RDS instance settles instantly; skipping the waiter keeps the demo
            # from blocking on a poll loop that has nothing to poll.
            argv.append("--no-wait")
        return session.call(argv)

    def _resolvers(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        return session.call(["resolvers"])

    def _tamper(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.demo is None:
            raise CliError(2, "only the demo account can be tampered with", ["tamper"])
        changed = session.demo.tamper()
        return {
            "argv": [
                "# someone else: aws ec2 modify-instance-attribute --instance-id %s "
                "--instance-type %s" % (changed["resource"], changed["value"])
            ],
            "exitCode": 0,
            "payload": changed,
        }

    def _reset(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.demo is None:
            raise CliError(2, "reset is only available in demo mode", ["reset"])
        session.demo.reset()
        if session.has_plan():
            os.remove(session.plan_path)
        return {"argv": ["# demo account reset"], "exitCode": 0, "payload": None}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Web front end for the rewind CLI.")
    parser.add_argument(
        "--mode",
        choices=["demo", "live"],
        default="demo",
        help="demo: a sanitized CloudTrail fixture and an in-memory fake account, no AWS "
        "call is possible. live: the ambient AWS configuration, like the rewind command.",
    )
    parser.add_argument("--identity", help="default identity to prefill")
    parser.add_argument("--region", help="default region to prefill")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    Handler.session = Session(args.mode, args.identity, args.region)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    banner = "rewind-ui [%s]  http://%s:%d" % (args.mode, args.host, args.port)
    sys.stderr.write("\n%s\n%s\n\n" % (banner, "-" * len(banner)))
    if args.mode == "demo":
        sys.stderr.write(
            "demo mode: fixture events, in-memory account. No AWS credentials are used.\n\n"
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

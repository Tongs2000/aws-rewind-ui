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

from runner import CLI_ROOT, CliError, run  # noqa: E402
from transcript import Transcript  # noqa: E402

STATIC = Path(__file__).resolve().parents[1] / "web"
DEFAULT_SINCE = "90m"
#: The demo data: derived from the CLI's live-validation capture by demodata/derive.py, which
#: documents exactly what it changed and why. The capture itself is never edited.
DEFAULT_TRANSCRIPT = Path(__file__).resolve().parents[1] / "demodata" / "session.txt"


class Session:
    """Server-side state: the mode, the replayed transcript, and the current plan file.

    In ``demo`` mode nothing runs: each route hands back one recorded command from a real
    session, output and all. In ``live`` mode ``plan`` and ``revert`` communicate through a
    plan file on disk, exactly as a terminal user's ``-o`` does.
    """

    def __init__(
        self,
        mode: str,
        identity: Optional[str],
        region: Optional[str],
        transcript_path: Optional[str] = None,
    ) -> None:
        self.mode = mode
        self.lock = threading.Lock()
        self.transcript: Optional[Transcript] = None
        if mode == "demo":
            self.transcript = Transcript(Path(transcript_path or DEFAULT_TRANSCRIPT))
        self.identity = identity or (self.transcript.identity if self.transcript else "")
        self.region = region or (self.transcript.region if self.transcript else "")
        #: demo mode has no live account to move, so `diff` after a confirmed revert
        #: replays the recorded verification run instead of the first one.
        self.applied = False
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
        return run(argv)

    def replay(self, step: str) -> Dict[str, Any]:
        assert self.transcript is not None
        return self.transcript.step(step)

    def has_plan(self) -> bool:
        return os.path.exists(self.plan_path)

    def describe(self) -> Dict[str, Any]:
        recorded = None
        if self.transcript:
            recorded = {
                "source": str(self.transcript.path),
                "account": self.transcript.account,
                "recordedAt": self.transcript.recorded_at,
                "commands": [command for command, _ in self.transcript.commands],
            }
        return {
            "mode": self.mode,
            "identity": self.identity,
            "region": self.region,
            "since": DEFAULT_SINCE,
            "planPath": self.plan_path if self.has_plan() else None,
            "recorded": recorded,
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
        self._json(200, result)

    def _scan(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.transcript:
            return session.replay("scan")
        return session.call(["scan"] + session.window_args(body))

    def _plan(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.transcript:
            # `--set` has no recording, so replay mode does not offer it rather than
            # inventing an output for it.
            return session.replay("plan")
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
        if session.transcript:
            # After the confirmed revert, the recorded session re-ran `diff` to verify it;
            # that is the run to show, because the account has moved.
            return session.replay("verify" if session.applied else "diff")
        if not session.has_plan():
            raise CliError(2, "no plan yet: run plan first", ["diff"])
        argv = ["diff", session.plan_path]
        if body.get("blame"):
            argv.append("--blame")
        return session.call(argv)

    def _revert(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.transcript:
            confirmed = bool(body.get("confirm"))
            session.applied = session.applied or confirmed
            return session.replay("applied" if confirmed else "dryRun")
        if not session.has_plan():
            raise CliError(2, "no plan yet: run plan first", ["revert"])
        argv = ["revert", session.plan_path]
        if body.get("confirm"):
            argv.append("--confirm")
        for chain_id in body.get("only") or []:
            argv += ["--only", str(chain_id)]
        return session.call(argv)

    def _resolvers(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.transcript:
            raise CliError(2, "`resolvers` is not part of the recorded session", ["resolvers"])
        return session.call(["resolvers"])

    def _reset(self, session: Session, body: Dict[str, Any]) -> Dict[str, Any]:
        if session.transcript is None:
            raise CliError(2, "reset is only available in demo mode", ["reset"])
        session.applied = False
        if session.has_plan():
            os.remove(session.plan_path)
        return {"argv": ["# replay rewound to the start"], "exitCode": 0, "payload": None}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Web front end for the rewind CLI.")
    parser.add_argument(
        "--mode",
        choices=["demo", "live"],
        default="demo",
        help="demo: replay a recorded real session; nothing runs and no AWS call is "
        "possible. live: the ambient AWS configuration, like the rewind command.",
    )
    parser.add_argument("--identity", help="default identity to prefill")
    parser.add_argument("--region", help="default region to prefill")
    parser.add_argument(
        "--transcript",
        metavar="FILE",
        help="the recorded session demo mode replays (default: the CLI's live-validation log)",
    )
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    Handler.session = Session(args.mode, args.identity, args.region, args.transcript)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    banner = "rewind-ui [%s]  http://%s:%d" % (args.mode, args.host, args.port)
    sys.stderr.write("\n%s\n%s\n\n" % (banner, "-" * len(banner)))
    if args.mode == "demo":
        recorded = Handler.session.transcript
        sys.stderr.write(
            "demo mode: replaying %s\n  %d recorded rewind command(s), account %s. "
            "Nothing runs and no credentials are used.\n\n"
            % (recorded.path.name, len(recorded.commands), recorded.account)
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

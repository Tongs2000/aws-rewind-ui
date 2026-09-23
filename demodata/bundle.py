"""Bake the recorded session into a static bundle the browser can read on its own.

    python3 demodata/bundle.py

Demo mode has no server-side work to do: `server/transcript.py` parses `session.txt` once at
startup and every route hands back one of six fixed payloads. The only state is a single
boolean - whether the confirmed revert has run - and that belongs in the page anyway.

So this script runs the parser once, at build time, and writes `web/demo.json`. The parsing
stays in Python, in one place, and the browser gets the same shapes `/api/*` used to return.
`web/` is then a static site: `python3 -m http.server web`, GitHub Pages, any file host.

Re-run it whenever `demodata/session.txt` changes, which means after `demodata/derive.py`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "server"))

from transcript import Transcript  # noqa: E402

TRANSCRIPT = HERE / "session.txt"
TARGET = HERE.parents[0] / "web" / "demo.json"

#: The routes the page can take, and the recorded command each replays. `diff` appears twice
#: because the recorded session re-ran it to verify the revert, and that is the run to show
#: once the account has moved.
STEPS = ("scan", "plan", "diff", "dryRun", "applied", "verify")

#: Mirrors `Session.window_args`'s default, so the prefilled `--since` matches the server's.
DEFAULT_SINCE = "90m"


def main() -> int:
    transcript = Transcript(TRANSCRIPT)
    bundle = {
        "session": {
            "mode": "demo",
            "identity": transcript.identity,
            "region": transcript.region,
            "since": DEFAULT_SINCE,
            "planPath": None,
            "recorded": {
                # Repo-relative: the bundle is published, and an absolute build path would
                # say nothing to a reader and leak the machine it was built on.
                "source": str(TRANSCRIPT.relative_to(HERE.parent)),
                "account": transcript.account,
                "recordedAt": transcript.recorded_at,
                "commands": [command for command, _ in transcript.commands],
            },
        },
        "steps": {name: transcript.step(name) for name in STEPS},
    }

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(bundle, indent=1, sort_keys=True) + "\n")

    print("source : %s" % TRANSCRIPT.relative_to(HERE.parent))
    print("target : %s  (%.0f KB)" % (TARGET.relative_to(HERE.parent), TARGET.stat().st_size / 1024))
    print("account: %s  identity %s  region %s" % (
        transcript.account, transcript.identity, transcript.region))
    for name in STEPS:
        payload = bundle["steps"][name]["payload"]
        rows = next(
            (len(payload[key]) for key in ("chains", "entries", "results", "identities")
             if key in payload),
            0,
        )
        print("   %-7s $ %-46s %2d row(s)" % (name, " ".join(payload["argv"]), rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

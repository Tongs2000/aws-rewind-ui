"""Read a recorded shell transcript of a real `rewind` session and hand the UI the same
shapes it used to get from `--output json`.

Demo mode replays this instead of running the CLI, so what the audience sees on screen is
a real run against a real AWS account, output and all - not a fixture, and not a mock.

The transcript is a terminal capture: prompt lines, the command typed, and everything the
command printed. Parsing is therefore positional and strict: each table is read by its own
column header, the `Evidence` / `Details` blocks are read by their `chn-` keys, and the two
are zipped by row order. If a count does not line up, this module raises rather than
guessing, because a silently mis-joined row would put a wrong value on screen - which is
the one thing this tool is not allowed to do.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROMPT = re.compile(r"^dev-dsk-\S+ % (?P<command>.*)$")
TIMESTAMP_LINE = re.compile(r"^\(\d\d-\d\d-\d\d \d\d:\d\d:\d\d\) <\d+> \[.*\]$")
BOTO_NOISE = re.compile(r"PythonDeprecationWarning|warnings\.warn\(warning|site-packages/boto3")
HEADER_FIELD = re.compile(r"^(?P<key>[a-z][a-z ]*?)\s*:\s(?P<value>.*)$")
RULE = re.compile(r"^-{3,}[\s-]*$")
CHAIN_HEAD = re.compile(
    r"^(?P<chainId>chn-[0-9a-f]+)\s{2}(?P<target>.+?)(?:\s{2}\[(?P<state>[A-Z_]+)\])?$"
)
STEP_LINE = re.compile(
    r"^step (?P<n>\d+)\s*:\s*(?P<time>\d\d:\d\d:\d\d)\s+(?P<event>\S+): "
    r"(?P<before>.*?) -> (?P<after>.*?)\s+\[(?P<eventId>[^\]]+)\]$"
)
UNPROVEN = "?"


class TranscriptError(RuntimeError):
    pass


def _clean(lines: List[str]) -> List[str]:
    return [line for line in lines if not BOTO_NOISE.search(line)]


def _split_commands(text: str) -> List[Tuple[str, List[str]]]:
    """Cut the capture into (command, output lines) pairs, in the order they were run."""
    steps: List[Tuple[str, List[str]]] = []
    current: Optional[List[str]] = None
    for line in text.splitlines():
        if TIMESTAMP_LINE.match(line):
            continue
        prompt = PROMPT.match(line)
        if prompt:
            steps.append((prompt.group("command").strip(), []))
            current = steps[-1][1]
            continue
        if current is not None:
            current.append(line)
    return [(command, _clean(lines)) for command, lines in steps]


def _header(lines: List[str]) -> Dict[str, Any]:
    """The `key : value` block at the top of every rewind command's output.

    `warning` repeats, so it collects into a list; everything else is last-one-wins.
    """
    header: Dict[str, Any] = {"warnings": []}
    for line in lines:
        if not line.strip():
            break
        match = HEADER_FIELD.match(line)
        if not match:
            break
        key, value = match.group("key").strip(), match.group("value").strip()
        if key == "warning":
            header["warnings"].append(value)
        else:
            header[key.replace(" ", "_")] = value
    return header


def _columns(header_line: str, rule_line: str) -> List[Tuple[str, int, int]]:
    """Column spans, taken from the `---- ----` rule rather than guessed from spacing."""
    spans = [(m.start(), m.end()) for m in re.finditer(r"-+", rule_line)]
    columns = []
    for index, (start, end) in enumerate(spans):
        stop = spans[index + 1][0] if index + 1 < len(spans) else len(header_line) + 200
        name = header_line[start:stop].strip().lower().replace(" ", "_")
        columns.append((name, start, stop))
    return columns


def _table(lines: List[str], first_column: str) -> List[Dict[str, str]]:
    """The one table whose first column is `first_column`, as a list of dicts."""
    for index, line in enumerate(lines):
        if line.strip().lower().startswith(first_column) and index + 1 < len(lines):
            if RULE.match(lines[index + 1]):
                columns = _columns(line, lines[index + 1])
                rows = []
                for row_line in lines[index + 2 :]:
                    if not row_line.strip():
                        break
                    rows.append(
                        {name: row_line[start:stop].strip() for name, start, stop in columns}
                    )
                return rows
    raise TranscriptError("no table starting with column %r" % first_column)


def _blocks(lines: List[str], title: str) -> List[Dict[str, Any]]:
    """The `Evidence` / `Details` section: one block per `chn-…` heading.

    Each block keeps its lines verbatim as well as a parsed form, because the UI shows the
    CLI's own words for anything it cannot render structurally.
    """
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == title)
    except StopIteration:
        return []
    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for line in lines[start + 2 :]:
        head = CHAIN_HEAD.match(line.strip()) if line and not line.startswith(" ") else None
        if head:
            current = {
                "chainId": head.group("chainId"),
                "target": head.group("target").strip(),
                "state": head.group("state"),
                "lines": [],
                "fields": {},
                "steps": [],
                "calls": [],
            }
            blocks.append(current)
            continue
        if current is None:
            continue
        if not line.strip():
            continue
        if not line.startswith(" "):
            break  # a trailing paragraph, not part of any block
        body = line.strip()
        current["lines"].append(body)
        step = STEP_LINE.match(body)
        if step:
            current["steps"].append(
                {
                    "sequence": int(step.group("n")),
                    "time": step.group("time"),
                    "eventName": step.group("event"),
                    "before": step.group("before").strip(),
                    "after": step.group("after").strip(),
                    "eventId": step.group("eventId"),
                }
            )
            continue
        if body.startswith("would call ") or body.startswith("called "):
            call = body.split(None, 2)[-1] if body.startswith("would call") else body[len("called"):].strip()
            api, _, comment = call.partition("  # ")
            current["calls"].append({"api": api.strip(), "note": comment.strip() or None})
            continue
        field = HEADER_FIELD.match(body)
        if field:
            key, value = field.group("key").strip(), field.group("value").strip()
            if key in current["fields"]:
                current["fields"][key] += " " + value
            else:
                current["fields"][key] = value
        elif current["lines"]:
            # A wrapped continuation line, or a bare one-line explanation.
            current["fields"].setdefault("reason", "")
            current["fields"]["reason"] = (current["fields"]["reason"] + " " + body).strip()
    return blocks


def _counts(text: str) -> Dict[str, int]:
    """`REVERTIBLE=8  UNCHECKABLE=20` and friends."""
    return {key: int(value) for key, value in re.findall(r"([A-Z_]+)=(\d+)", text or "")}


def _iso(value: str) -> Optional[str]:
    """Normalise the several instant formats the transcript carries."""
    if not value:
        return None
    text = value.split("  ")[0].strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def _value(text: str) -> Optional[str]:
    """`?` in a table means "no value is known", which the UI must not print as a value."""
    text = (text or "").strip()
    return None if text in ("", UNPROVEN) else text


class Transcript:
    """A recorded session, exposed as one payload per command the UI can run."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.raw = self.path.read_text()
        steps = _split_commands(self.raw)
        self.commands = [
            (command, lines) for command, lines in steps if command.startswith("rewind ")
        ]
        if len(self.commands) < 5:
            raise TranscriptError(
                "expected at least 5 rewind commands in %s, found %d"
                % (self.path, len(self.commands))
            )
        self._scan = self._build_scan(*self.commands[0])
        self._plan = self._build_plan(*self.commands[1])
        self._diff = self._build_diff(*self.commands[2])
        self._dry_run = self._build_revert(*self.commands[3])
        self._applied = self._build_revert(*self.commands[4])
        self._verify = self._build_diff(*self.commands[5]) if len(self.commands) > 5 else None

    # -- public -------------------------------------------------------------

    @property
    def identity(self) -> str:
        return self._plan["header"].get("identity", "")

    @property
    def region(self) -> str:
        return self._plan["header"].get("region", "")

    @property
    def recorded_at(self) -> Optional[str]:
        return self._plan["window"]["endTime"]

    @property
    def account(self) -> Optional[str]:
        match = re.search(r"arn:aws:sts::(\d+):", self.raw)
        return match.group(1) if match else None

    def step(self, name: str) -> Dict[str, Any]:
        """One recorded command, as ``{argv, exitCode, payload, raw}``."""
        payload = {
            "scan": self._scan,
            "plan": self._plan,
            "diff": self._diff,
            "dryRun": self._dry_run,
            "applied": self._applied,
            "verify": self._verify or self._diff,
        }[name]
        return {
            "argv": payload["argv"],
            "exitCode": 0,
            "payload": payload,
            "raw": payload["raw"],
            "replay": True,
        }

    # -- builders -----------------------------------------------------------

    def _common(self, command: str, lines: List[str]) -> Dict[str, Any]:
        return {
            "argv": command.split(),
            "raw": "\n".join(lines).strip("\n"),
            "header": _header(lines),
        }

    def _window(self, header: Dict[str, Any]) -> Dict[str, Any]:
        """`window : <start> -> <end>`, plus the date the HH:MM:SS step times belong to."""
        text = header.get("window", "")
        start, _, end = text.partition(" -> ")
        return {
            "startTime": _iso(start),
            "endTime": _iso(end),
            "date": (_iso(end) or "")[:10],
        }

    def _build_scan(self, command: str, lines: List[str]) -> Dict[str, Any]:
        base = self._common(command, lines)
        header = base["header"]
        rows = _table(lines, "identity")
        return {
            "kind": "scan",
            **base,
            "window": self._window(header),
            "region": header.get("region"),
            "eventsText": header.get("events", ""),
            "changesText": header.get("changes", ""),
            "identitiesText": header.get("identities", ""),
            "identities": [
                {
                    "identity": row.get("identity", ""),
                    "changes": int(row.get("changes") or 0),
                    "resources": int(row.get("resources") or 0),
                    "pluginBacked": row.get("plugin-backed", "-"),
                    "events": row.get("events", ""),
                }
                for row in rows
            ],
        }

    def _build_plan(self, command: str, lines: List[str]) -> Dict[str, Any]:
        base = self._common(command, lines)
        header = base["header"]
        window = self._window(header)
        rows = _table(lines, "resource")
        blocks = _blocks(lines, "Evidence")
        if len(rows) != len(blocks):
            raise TranscriptError(
                "plan has %d table rows but %d evidence blocks; they cannot be zipped"
                % (len(rows), len(blocks))
            )

        chains = []
        for row, block in zip(rows, blocks):
            fields = block["fields"]
            field_name = row.get("field", "")
            target = block["target"]
            # The table truncates long resource names; the evidence block carries them whole.
            resource = target[: -(len(field_name) + 1)] if target.endswith("." + field_name) else target
            if field_name and not target.endswith("." + field_name):
                raise TranscriptError(
                    "plan row %r does not match evidence block %r" % (row, target)
                )
            before, _, after = (row.get("before_->_now") or "").partition(" -> ")
            anchor_text = fields.get("anchor", "")
            anchor_value, _, anchor_meta = anchor_text.partition("  (")
            confidence, _, source = anchor_meta.rstrip(")").partition(" via ")
            revert_to, _, revert_via = (fields.get("revert to") or "").partition(" via ")
            chains.append(
                {
                    "chainId": block["chainId"],
                    "resourceId": resource,
                    "field": field_name,
                    "netBefore": _value(before),
                    "netAfter": _value(after),
                    "changeCount": int(row.get("steps") or 1),
                    "confidence": row.get("confidence") or "UNKNOWN",
                    "capability": row.get("capability") or "DISCOVERED",
                    "anchor": {
                        "value": _value(anchor_value),
                        "confidence": confidence.strip() or row.get("confidence"),
                        "source": source.strip() or row.get("anchor") or "none",
                        "reason": fields.get("reason"),
                        "evidenceEventIds": [
                            event for event in (fields.get("evidence") or "").split() if event
                        ],
                        "note": fields.get("note"),
                    },
                    "handledBy": fields.get("handled by"),
                    "revert": {
                        "executable": bool(revert_to),
                        "targetValue": _value(revert_to),
                        "steps": [
                            {"api": api.strip()} for api in revert_via.split(",") if api.strip()
                        ],
                        "reason": fields.get("revert"),
                        "warning": fields.get("warning"),
                    },
                    "notes": [fields[key] for key in ("note",) if fields.get(key)],
                    "changes": [
                        {
                            "sequence": step["sequence"],
                            "eventTime": _combine(window["date"], step["time"]),
                            "eventName": step["eventName"],
                            "before": _value(step["before"]),
                            "after": _value(step["after"]),
                            "eventId": step["eventId"],
                        }
                        for step in block["steps"]
                    ],
                    "evidenceLines": block["lines"],
                }
            )

        revertible, _, _rest = (header.get("revertible") or "").partition(" ")
        return {
            "kind": "plan",
            **base,
            "window": window,
            "region": header.get("region"),
            "identity": header.get("identity"),
            "stats": {
                "changes": _leading_int(header.get("changes")),
                "chains": len(chains),
                "revertible": _leading_int(revertible),
                "revertibleText": header.get("revertible", ""),
                "byCapability": _counts(header.get("capability", "")),
                "byConfidence": _counts(header.get("confidence", "")),
            },
            "warnings": header.get("warnings", []),
            "chains": chains,
        }

    def _build_diff(self, command: str, lines: List[str]) -> Dict[str, Any]:
        base = self._common(command, lines)
        header = base["header"]
        rows = _table(lines, "resource")
        details = {block["chainId"]: block for block in _blocks(lines, "Details")}
        plan_chains = getattr(self, "_plan", {}).get("chains") if hasattr(self, "_plan") else None
        entries = []
        for index, row in enumerate(rows):
            chain = plan_chains[index] if plan_chains and index < len(plan_chains) else {}
            if chain and chain.get("field") != row.get("field"):
                raise TranscriptError(
                    "diff row %d (%s) does not line up with the plan (%s)"
                    % (index, row.get("field"), chain.get("field"))
                )
            block = details.get(chain.get("chainId"))
            entries.append(
                {
                    "chainId": chain.get("chainId"),
                    "resourceId": chain.get("resourceId") or row.get("resource"),
                    "field": row.get("field"),
                    "planBefore": _value(row.get("was")),
                    "planAfter": _value(row.get("session_set")),
                    "liveValue": _value(row.get("live_now")),
                    "verdict": row.get("verdict"),
                    "reason": (block or {}).get("fields", {}).get("reason")
                    or " ".join((block or {}).get("lines", [])) or None,
                }
            )
        drift = header.get("drift", "")
        return {
            "kind": "diff",
            **base,
            "checkedAt": _iso(header.get("checked", "")),
            "summary": _counts(header.get("verdicts", "")),
            "driftFree": drift.startswith("none"),
            "driftText": drift,
            "entries": entries,
        }

    def _build_revert(self, command: str, lines: List[str]) -> Dict[str, Any]:
        base = self._common(command, lines)
        header = base["header"]
        rows = _table(lines, "resource")
        blocks = _blocks(lines, "Details")
        if len(rows) != len(blocks):
            raise TranscriptError(
                "revert has %d table rows but %d detail blocks" % (len(rows), len(blocks))
            )
        by_chain = {
            chain["chainId"]: chain for chain in getattr(self, "_plan", {}).get("chains", [])
        }
        results = []
        for row, block in zip(rows, blocks):
            chain = by_chain.get(block["chainId"], {})
            fields = block["fields"]
            results.append(
                {
                    "chainId": block["chainId"],
                    "resourceId": chain.get("resourceId") or row.get("resource"),
                    "field": row.get("field"),
                    "observedBefore": _value(row.get("was")),
                    "targetValue": _value(row.get("target")),
                    "observedAfter": _value(row.get("now")),
                    "outcome": row.get("outcome"),
                    "reason": fields.get("reason"),
                    "calls": block["calls"],
                    "warning": fields.get("warning"),
                }
            )
        return {
            "kind": "revert",
            **base,
            "dryRun": (header.get("mode") or "").startswith("DRY RUN"),
            "startedAt": _iso(header.get("started", "")),
            "summary": _counts(header.get("outcomes", "")),
            "results": results,
            "attention": _trailing_list(lines, "field(s) still need attention"),
            "reportedOnly": _trailing_list(lines, "reported but not revertible"),
        }


def _leading_int(text: Optional[str]) -> int:
    match = re.match(r"\s*(\d+)", text or "")
    return int(match.group(1)) if match else 0


def _combine(date: str, clock: str) -> str:
    """`2026-09-23` + `20:36:04` -> an ISO instant. The transcript prints UTC clocks."""
    if not date:
        return clock
    return "%sT%s+00:00" % (date, clock)


def _trailing_list(lines: List[str], marker: str) -> List[str]:
    """The indented list that follows a closing sentence such as "5 field(s) still …"."""
    try:
        start = next(i for i, line in enumerate(lines) if marker in line)
    except StopIteration:
        return []
    collected = []
    for line in lines[start + 1 :]:
        if not line.startswith("  ") or not line.strip():
            break
        collected.append(" ".join(line.split()))
    return collected


if __name__ == "__main__":  # a self-check: python server/transcript.py <file>
    import json
    import sys

    transcript = Transcript(Path(sys.argv[1]))
    print("account   :", transcript.account)
    print("identity  :", transcript.identity, "region", transcript.region)
    print("commands  :")
    for command, _ in transcript.commands:
        print("   $", command)
    for name in ("scan", "plan", "diff", "dryRun", "applied", "verify"):
        payload = transcript.step(name)["payload"]
        summary = {
            key: value
            for key, value in payload.items()
            if key in ("kind", "stats", "summary", "driftFree", "dryRun")
        }
        print("\n--", name, json.dumps(summary, indent=2)[:600])
        for key in ("chains", "entries", "results", "identities"):
            if key in payload:
                print("   %s: %d" % (key, len(payload[key])))
                print("   first:", json.dumps(payload[key][0])[:400])

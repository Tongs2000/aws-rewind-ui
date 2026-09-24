# rewind-ui

A web front end for [`rewind`](../aws-rewind-cli), built for a five-minute demo.

It is a **client of the CLI**, not a second implementation. In demo mode it replays a
transcript of six `rewind` commands run against AWS account `111122223333`, and every table,
value and event id on screen is read out of that run's own output. The terminal pane keeps
that output verbatim, so anything on screen can be checked against it in one keystroke.

The transcript it replays is `demodata/session.txt`, **derived** from the CLI's
live-validation capture by `demodata/derive.py` — see [Demo data](#demo-data) for exactly
what was changed and why.

Stdlib Python and plain JavaScript: no framework, no build step, no dependency added to the
CLI package, and `src/rewind` is not touched.

---

## Run

```sh
./run.sh                       # replay demodata/session.txt, http://127.0.0.1:8787
./run.sh --transcript FILE     # replay a different capture (e.g. the unedited one)
./run.sh --mode live           # real account, via the ambient AWS configuration
./run.sh --mode live --identity perf-agent --region us-west-1 --port 9000
```

Or with no server at all, which is how the published page runs:

```sh
python3 demodata/bundle.py     # bake the transcript into web/demo.json
python3 -m http.server -d web  # http://127.0.0.1:8000
```

**Demo mode** (the default) runs nothing. Each route hands back one recorded command: its
argv, its exit code, its verbatim output, and that output parsed into the shapes the panels
need. No credentials are read and no call leaves the machine. Reloading the page rewinds the
replay to step 0, so a refresh is always a clean start. It needs neither `boto3` nor the CLI
beside it — a checkout of this repo alone serves the demo.

**Static mode** is demo mode without the server. `demodata/bundle.py` runs the transcript
parser once and writes `web/demo.json`; the page then answers its own `/api/*` calls from
that bundle, holding the one piece of demo state (has the confirmed revert run?) in the page.
The payloads are byte-identical to the server's, because they *are* the server's — the same
`server/transcript.py` produced them. `web/` is then publishable anywhere static files are.
`web/demo.json` is generated, so it is not committed; CI rebuilds it on every deploy and the
published bundle cannot drift from `demodata/session.txt`.

**Live mode** injects nothing: `rewind.cli.main` builds its own CloudTrail and boto3 clients
exactly as the installed `rewind` command does, reading `--output json`. It needs `boto3`
(use the CLI's virtualenv, which `run.sh` picks up) and credentials. `Confirm revert` in live
mode writes to real resources; the button asks first and says so.

---

## How to drive it

**Press the big amber button six times.** That is the entire demo — the six commands the
recorded session ran, in order. <kbd>space</kbd> does the same thing, so you can present
without hunting for the cursor. The button always names the step it is about to run and,
under it, the exact command that step replays.

| Press | Command | What appears |
|---|---|---|
| 1 | `rewind scan --since 30m` | 9 identities made a tracked change; the top one made 14 changes across 6 resources, 6 of them revertible. No before-values exist yet |
| 2 | `rewind plan --identity … --explain` | all 14 fields, each with its before-value, confidence, capability and the resolver that proved it |
| 3 | `rewind diff plan.json` | each field's live value now: 6 `REVERTIBLE`, 8 `UNCHECKABLE`, no drift |
| 4 | `rewind revert plan.json` | the 6 calls a revert would make, newest change first. Nothing is called |
| 5 | `rewind revert --confirm` | 4 `REVERTED`, 2 `SUBMITTED`, 8 `SKIPPED` |
| 6 | `rewind diff plan.json` | the verification run: 6 `ALREADY_REVERTED`, 8 `UNCHECKABLE` |

**Or press `Undo it all`** (<kbd>a</kbd>) to run all six half a second apart. That is the
one-click version of the same thing, and it is what `rewind undo --confirm` does in a single
command: plan, diff and revert in one pass, still dry-run unless `--confirm` is given. The
recording predates `undo`, so the terminal pane shows the commands it composes rather than a
combined report that run never printed. Click it again or press <kbd>Esc</kbd> to stop; the
steps already run stay on screen. In live mode it asks once, up front, before writing
anything.

The six small numbered buttons are the same steps, for when a question sends you back one.
<kbd>t</kbd> opens the terminal pane, <kbd>?</kbd> the help card.

### What is where on the page

```
┌ header ─────────────── mode badge · terminal · ? · start over ───┐
├ DRIVER ── [ big amber button ] [Undo it all] what this step asks + its command ┤
├ query ──── identity / region / what is being replayed            ┤
├ command ── $ rewind plan … (the command that just ran)           ┤
├ TERMINAL ─ every command's own output, verbatim  (t to toggle)   ┤  ← the receipt
├ banner ─── what just happened, in one sentence                   ┤
├ stats ──── changes · fields · auto-revertible · confidence · $0  ┤
├ TIMELINE ─ the session, draggable; table below = state at the playhead ┤
├ CHANGES ──────────────────────────────┬─ EVIDENCE ───────────────┤
│ ▾ Revertible & reverted  6            │ the event that proves     │
│   [cards]                             │ the before-value, the     │
│ ▸ skipped                8  (why)     │ chain, the revert calls,  │
│                                       │ and the CLI's own words   │
├ footer ─── revertible summary · the calls in order · [Confirm revert] ┤
```

Clicking a card lights up that field's events on the timeline and fades the others;
hovering previews the link. Clicking a dot selects the matching card and moves the playhead
to that moment. The list and the timeline are the same data seen two ways.

### The terminal pane

<kbd>t</kbd>. One block per command, in the order they ran: the command line, then its
output exactly as it was printed — the tables, the `Evidence` and `Details` sections, the
closing advice, all of it. This is the answer to "is this real?", and it is why the panels
are allowed to be a rendering rather than the source of truth.

### The timeline

The track is the identity's session and nothing else: one dot per change, on a real time
axis, left edge = the whole minute before the first change.

```
before       ①②③──────────────────────────④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭  now
the session  └ 20:36 ─────────────────────── 20:52 ┘ playhead
```

**The playhead never moves on its own.** It sits at `now` until you drag the track or click
a dot. Drag it to the far left and the table below shows what every field held *before the
agent started* — which is exactly what the plan's before-values say. That, and not an
animation, is the rewind.

Changes cluster in time — one call can even change several resources at the same instant —
so dots are laid out with a minimum gap: each starts at its true time and is pushed right only
as far as it must be to clear its neighbour. Order is exact and the tooltip carries the true
timestamp; only the spacing inside a cluster is approximate. `dev/smoke.mjs` asserts no two
dots touch.

The table under the track lists only fields that carry a value at all. The other 8 are
changes CloudTrail recorded with no value in them — they belong in the card list, not in a
table of values.

### Grouping: only what can be acted on is open

Each field gets **one status**, from whichever step read it last — by the clock, not by which
command it was. The list groups on it, the timeline dims on it, the table and the footer count
on it, so they cannot disagree.

That ordering is what makes step 6 mean something: a field the revert could only report as
`SUBMITTED` — RDS Multi-AZ, EC2's monitoring flag — has settled by the time the verification
diff reads it, so the newer read wins and the field becomes `ALREADY_REVERTED`. All six end
green, and the stats bar shows only the newer read's counts, because `submitted 2` beside
`already reverted 6` would be two answers to one question. The step that reported it is still
in the banner and verbatim in the terminal pane.

The actionable statuses — `AUTO`, `REVERTIBLE`, `DRY_RUN`, `REVERTED`, `SUBMITTED`,
`ALREADY_REVERTED`, `FAILED`, `CONFLICT` — stay open. Everything else collapses into a
counted group whose header says why, and its dots dim on the timeline:

| Step | Open | Collapsed |
|---|---|---|
| 2 plan | 6 | `discovered` 8 — CloudTrail recorded the change but not the value it set |
| 3 diff | 6 | `uncheckable` 8 — no plugin knows which Describe call reads this field |
| 4–6 revert | 6 | `skipped` 8 — the previous value is not proven, so there is nothing to restore |

Nothing is dropped, ever: a change rewind can only report is still counted and one click
away. That is the trust story — the tool says what it does not know, in detail, rather than
printing a plausible-looking value. (`--set`, supplying a value by hand, is not in this
recording, so the UI does not offer it.)

## Demo data

The demo replays `demodata/session.txt`, which is **derived** from the CLI's live-validation
capture (`aws-rewind-cli/docs/live-validation-2026-09-23-original.txt`). The capture is the
record of what happened; the derived copy exists so the demo shows one clean story instead of
stopping to explain a terminated instance. `demodata/derive.py` regenerates it and is the
authoritative statement of what differs:

```sh
python3 demodata/derive.py     # rewrites demodata/session.txt and prints every count it changed
```

Resources that no longer exist are taken out of the demo, one row is relabelled, and every
count is recomputed. Nothing else — no re-typing, no re-wording, no invented rows:

1. **`i-0ddd77778888ddd04` and `i-0bbb33334444bbb02` are removed from the demo.** Both were
   terminated mid-session, so their `instanceType` could never be restored: the real run
   ended with `IncorrectInstanceState` on each. Every row, evidence block and identity line
   that mentions either instance is dropped, as if they had never been in the session.
2. **Four more fields go with them:** `RunInstances` and `TerminateInstances` on
   `i-0eee99990000eee05` and `i-0ccc55556666ccc03`. Those two instances were created *and*
   terminated inside the window and no other field of theirs was touched, so they are gone
   too. Other identities' calls against them (`UpdateInstanceInformation`,
   `RegisterManagedInstance`) stay — those happened and are not this identity's changes,
   which is why the scan table still lists 9 identities.
3. **The `monitoring` revert on `i-0aaa11112222aaa01` reads `SUBMITTED`, not `FAILED`.** The
   call was accepted and the field does read `disabled`; only the immediate read-back had not
   converged — which is exactly what `SUBMITTED` means everywhere else in this tool.
4. **Every count derived from those rows is recomputed** — `changes`, `fields`, `revertible`,
   `capability`, `confidence`, `verdicts`, `outcomes`, the drift sentence, the scan table's
   own row, and the two trailing lists — so no number on screen contradicts the table above
   it. The derivation is checked by re-reading the result: the parser raises if any table and
   its evidence blocks stop lining up.

That leaves 14 fields: 6 revertible (2 `instanceType`, 2 `monitoring`,
`provisionedConcurrency`, `multiAZ`) and 8 that CloudTrail recorded without a value.

Everything else, including every event id, timestamp and the CLI's own wording, is the
original output byte for byte. `session.txt` opens with a header saying so.

One thing is changed in the capture itself, before either file is published: the account id,
the role id, the six instance ids and the host name in the shell prompt were replaced with
placeholders of the same length, so the tables stay aligned. That is why the demo runs against
account `111122223333` and an identity called `alice-DevAccount`. Every other byte — the
values, the counts, the event ids, the timings, the failures — is the run.

To present the unedited run instead — 3 `FAILED` and all — point the server at the capture:

```sh
./run.sh --transcript ../aws-rewind-cli/docs/live-validation-2026-09-23-original.txt
```

It replays without any code change, and the failures are worth showing if you have the time
for them: each one was a real defect, and all three are fixed in the CLI
(`Fix three revert defects found by live validation`).

---

## Colour language

Used consistently and for nothing else:

| | Meaning |
|---|---|
| green | `HIGH` confidence, `AUTO` capability, or a value successfully restored |
| amber | `MEDIUM` confidence; also the accent for the agent's changes and for the act of reverting |
| blue | `ASSERTED` — a human supplied this value |
| grey, dashed | `UNKNOWN` / `DISCOVERED` / `UNCHECKABLE` — not proven, and not an error |
| red | one thing only: a failed call, a conflict, or an unreadable resource |

---

## Layout

```
rewind-ui/
  run.sh              start it
  demodata/
    derive.py         builds session.txt from the capture, and says what it changed
    session.txt       the transcript the demo replays
  server/
    transcript.py     parse the recorded session into the shapes the UI needs
    runner.py         live mode: call rewind.cli.main, capture the JSON
    app.py            stdlib HTTP server: static files + one route per rewind command
  web/
    index.html        the whole page
    app.css           the colour language above
    app.js            layout of the parsed output; the playhead
  dev/
    smoke.mjs         end-to-end UI test, see below
```

Routes, all POST except the first, all returning `{argv, exitCode, payload, raw}`:
`GET /api/session`, `/api/scan`, `/api/plan`, `/api/diff`, `/api/revert`, `/api/reset`.

`transcript.py` is strict on purpose: each table is read by its own `--- ---` rule, the
`Evidence` / `Details` blocks are read by their `chn-` keys, and the two are zipped by row
order with the field name checked on every row. A mismatch raises rather than guessing,
because a silently mis-joined row would put a wrong value on screen — the one thing this
tool is not allowed to do. Run it directly to see what it found:

```sh
python3 server/transcript.py demodata/session.txt
```

---

## Testing the UI

`dev/smoke.mjs` drives the real page against a running server in jsdom: all six presses, the
filter chips, the evidence panel, the terminal pane, the playhead, and a set of assertions
for the failures that would not throw — dots leaking their tooltip onto the axis, dots
touching, CSS rules deleted, and a sample of on-screen values that must be present in the
verbatim output.

jsdom is intentionally not vendored here — install it wherever it is convenient:

```sh
cd /tmp && mkdir -p rwtest && cd rwtest && npm i jsdom
cp /path/to/rewind-ui/dev/smoke.mjs .
./run.sh &                 # in the rewind-ui directory
node smoke.mjs             # exits non-zero on any failure
```

It takes a base URL, so the same suite covers both transports — point it at a plain file
server to test the published page:

```sh
python3 demodata/bundle.py && python3 -m http.server -d web 8000 &
REWIND_UI=http://127.0.0.1:8000 node smoke.mjs
```

---

## Deploying

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages on every push to `main`: it
runs `demodata/bundle.py` to build `web/demo.json`, then uploads the directory. Enable it once
in **Settings → Pages → Source → GitHub Actions**.

Only the demo ships. Live mode needs a server, credentials and the CLI, none of which exist on
Pages, so the published page has no path to an AWS call — `backend.open()` finds no
`/api/session`, falls back to the bundle, and every button replays a recording.

Note that Pages on a **private** repository serves a private site, which needs a paid GitHub
plan. On a free account the repository has to be public for the link to work for anyone else.

---

## Five-minute script

Left column is what you do, right column is roughly what you say.

| Time | Do | Say |
|---|---|---|
| 0:00 | (page open) | "This is a recording of a real run against a real account. Everything you are about to see came out of that run, and the terminal pane keeps it verbatim." |
| — | *(if you have 60 seconds, not five: press* **Undo it all** *and narrate the six steps as they land — that is `rewind undo --confirm`, one command)* | |
| 0:25 | **press 1** | "Nine identities touched this account in half an hour. One of them is the one we care about: 14 changes, 6 resources. And nothing here says what any of those values *was* — CloudTrail records what a call set, never what it replaced." |
| 1:05 | **press 2** | "Now every field has a before-value with the evidence for it — and 8 of them say question mark, out loud, with the reason." |
| 1:30 | click an `AUTO` card | "`t3.micro`, MEDIUM, via the creation event — and here is the event id that proves it." |
| 1:55 | drag the playhead left | "That column is the account before the agent touched it." |
| 2:20 | expand **skipped**, click one | "Eight changes where CloudTrail recorded that it happened but not what it set. `TerminateInstances` has no value in it. The tool says so rather than inventing one." |
| 2:50 | **press 3** | "Live values now. Six ready, no drift, eight that nothing can even check — and it names which Describe call is missing." |
| 3:15 | **press 4** | "Dry run. Six calls, newest change first, stop-modify-start where an instance type needs it. Nothing was called." |
| 3:45 | **press 5** | "Applied. Four restored and confirmed by a read-back. Two came back *submitted*, not *done*: RDS applies Multi-AZ asynchronously and EC2's monitoring flag had not converged yet, so the tool says accepted-not-settled rather than claiming success." |
| 4:25 | **press 6** | "Verify: all six read back at their original value — including the two that were only *submitted* last step. Re-running is how an asynchronous field gets closed, and it never claims a field is fine without reading it." |
| 4:45 | press <kbd>t</kbd> | "And all of that is the CLI's own output. Read-only by default, one mutating code path, no database, nothing running in the account, $0 on the bill." |

If you are short on time, cut the **skipped** beat (2:20) and the `AUTO` card (1:30) — in that
order. If you have time to spare, run `./run.sh --transcript …-original.txt` instead: the
unedited capture ends with 3 `FAILED`, each one a real defect this validation found and the
CLI has since fixed, and "our own validation caught three bugs" lands better than a clean run.

# rewind-ui

A web front end for [`rewind`](../aws-rewind-cli), built for a five-minute demo.

It is a **client of the CLI**, not a second implementation. Every panel is drawn from a
`rewind <command> --output json` document, and the exact argv that produced it is shown
across the top of the page. Nothing on screen is computed from anywhere else, with one
deliberate exception noted under [The timeline](#the-timeline).

Stdlib Python and plain JavaScript: no framework, no build step, no dependency added to
the CLI package, and `src/rewind` is not touched.

---

## Run

```sh
./run.sh                 # demo mode, http://127.0.0.1:8787
./run.sh --mode live     # real account, via the ambient AWS configuration
./run.sh --mode live --identity perf-agent --region us-west-1 --port 9000
```

**Demo mode** (the default) uses the CLI's sanitized CloudTrail fixture as the event
source and an in-memory fake account for the read and write APIs. No credentials are
read and no call leaves the machine. The fake account is stateful for the life of the
process, so a revert really does move it and a later `diff` sees the moved state — which
is what makes the last act of the demo land.

**Live mode** injects nothing: `rewind.cli.main` builds its own CloudTrail and boto3
clients exactly as the installed `rewind` command does, so it needs `boto3` (use the
CLI's virtualenv, which `run.sh` picks up automatically) and credentials. `Confirm
revert` in live mode writes to real resources; the button asks first and says so.

---

## How to drive it

**Press the big amber button five times.** That is the entire demo. <kbd>space</kbd> does
the same thing, so you can present without hunting for the cursor. The button always
names the step it is about to run and, under it, the command that step will execute.

| Press | Runs | What appears |
|---|---|---|
| 1 | `rewind scan` | every field the identity changed — with every before-value `?`, because CloudTrail records only the value each call *set* |
| 2 | `rewind plan -o plan.json` | the before-value for each field, with its confidence and the resolver that proved it |
| 3 | `rewind diff plan.json --blame` | what each field holds right now, and whether anything moved since the plan |
| 4 | `rewind revert plan.json` | the exact API calls a revert would make. Nothing is called |
| 5 | `rewind revert plan.json --confirm` | applies it, newest change first, each verified by a read-back |

The five small numbered buttons next to it are the same steps, out of order, for when a
question sends you back a step. `?` opens a help card with the same summary.

`plan` writes a real plan file in a temp directory, and `diff` and `revert` read it back,
so the UI keeps the same contract a terminal user has with `-o`.

### What is where on the page

```
┌ header ─────────────────── mode badge · ? · simulate-someone-else · reset ┐
├ DRIVER ── [ big amber button ] what this step does + the command it runs  ┤
├ query ──── identity / window / region                                     ┤
├ command ── $ rewind plan … --output json          [raw JSON]              ┤  ← the real argv
├ banner ─── what just happened, in one sentence                            ┤
├ stats ──── changes · fields · revertible · HIGH/MEDIUM/UNKNOWN · $0       ┤
├ TIMELINE ─ the session, draggable; table below = state at the playhead    ┤
├ CHANGES ──────────────────────────────┬─ EVIDENCE ────────────────────────┤
│ one card per field, click to select   │ which event proves the before-    │
│ dashed grey card = unproven, type in  │ value, the change chain, and the  │
│                                       │ API calls a revert would make     │
├ footer ─── revertible summary · the revert's calls in order · [Dry run] [Confirm] ┤
```

Clicking a card lights up that field's events on the timeline and fades the others;
hovering previews the link. Clicking a dot selects the matching card and moves the
playhead to that moment. The list and the timeline are the same data seen two ways.

### The timeline

The track is the agent's session and nothing else: one dot per change, on a real time axis.

```
before       ①─②────③──④⑤────⑥────⑦────⑧────────┃  now
the session  └ 17:21 ──────────────────── 17:30 ┘ playhead
```

**The playhead never moves on its own.** It sits at `now` until you drag the track or click
a dot — a presenter should be able to talk over a still picture. Drag it to the far left and
the table below shows what every field held *before the agent started*, which is exactly
what the plan's anchors say. That, and not an animation, is the rewind.

What each step adds, and where:

| Step | What appears | Where |
|---|---|---|
| 1 scan | the dots | timeline |
| 2 plan | before-values, confidence, source | cards, and the table when you drag left |
| 3 diff | dots take on each field's state — red conflict, green restored, dashed grey unproven | timeline + cards |
| 4 dry run | the calls a revert would make, numbered in execution order, dashed | footer bar |
| 5 confirm | those same calls turn green; the table marks each field ✓ restored | footer bar + table |

The revert deliberately does **not** live on the timeline. It is an ordered list of
operations, not a moment in the session, and drawing it on the time axis made it read as
"the timeline grew a piece of the future".

Two events can carry the same timestamp — `MonitorInstances` takes a list of instances — so
co-located dots are nudged apart by a fixed number of pixels rather than stacked on top of
each other. The nudge is in pixels, not percent, because a percentage that clears a 16px dot
on a wide screen still overlaps on a narrow one; `dev/smoke.mjs` re-checks every dot for
overlap at 1000, 1440 and 1920px, and asserts the playhead is still at `now` after all five
presses.

### The unproven case

A field the tool cannot prove a previous value for gets a dashed card, an `UNKNOWN` chip
and an input box. The evidence panel lists **every resolver that was tried and why each
one missed** — parsed out of the anchor note the CLI already emits.

Type a value and the UI re-runs `plan` with `--set <chainId>=<value>`. The field comes
back as `ASSERTED`, blue rather than green, sourced `operator-supplied`, with the CLI's
own note: *"the tool did not verify it"*. The point of the panel is that the tool will
happily act on a human's value and will never invent one itself.

### Simulating a conflict (demo mode)

**Simulate someone else's change** sets `i-0aaa….instanceType` to `t3.xlarge` behind the
plan's back. Re-run `Check drift` and that field turns `CONFLICT`; a revert then skips it
with the CLI's reason — *"something outside this plan changed it"* — while still
restoring everything else. Worth the twenty seconds it costs on stage.

### Reset

Throws the fake account away and starts over, so the demo can be run twice in a row.

---

## Colour language

Used consistently and for nothing else:

| | Meaning |
|---|---|
| green | `HIGH` confidence, or a value successfully restored |
| amber | `MEDIUM` confidence; also the accent for the agent's changes and for the act of reverting |
| blue | `ASSERTED` — a human supplied this value |
| grey, dashed | `UNKNOWN` — not proven, and not an error |
| red | one thing only: a conflict or a failed call |

---

## Layout

```
rewind-ui/
  run.sh              start it
  server/
    runner.py         calls rewind.cli.main, captures the JSON, injects the demo world
    app.py            stdlib HTTP server: static files + one route per rewind command
  web/
    index.html        the whole page
    app.css           the colour language above
    app.js            layout of the JSON documents; the scrubber
  dev/
    smoke.mjs         end-to-end UI test, see below
```

Routes, all POST except the first, all returning `{argv, exitCode, payload, account}`:
`GET /api/session`, `/api/scan`, `/api/plan`, `/api/diff`, `/api/revert`,
`/api/resolvers`, `/api/tamper`, `/api/reset`.

---

## Testing the UI

`dev/smoke.mjs` drives the real page against a running server in jsdom: every act, the
evidence panel for a proved and an unproved field, supplying a value, the scrubber, a
confirmed revert, the conflict beat, and a check that no JavaScript error fired.

jsdom is intentionally not vendored here — install it wherever it is convenient:

```sh
cd /tmp && mkdir -p rwtest && cd rwtest && npm i jsdom
cp /path/to/rewind-ui/dev/smoke.mjs .
./run.sh &                 # in the rewind-ui directory
node smoke.mjs
```

---

## Five-minute script

Left column is what you do, right column is roughly what you say.

| Time | Do | Say |
|---|---|---|
| 0:00 | (page open, nothing run) | "An agent held credentials for 90 minutes last night. CloudTrail will tell you what it *set*. Nothing will tell you what it *replaced*." |
| 0:30 | **press 1** | "Eight changes, six fields — and every before-value is a question mark. That column is the problem." |
| 1:10 | **press 2** | "Now they are filled in, and every one carries the evidence that proved it. Nothing is guessed." |
| 1:35 | click the 2-step card | "This instance was resized twice. The value to restore is the one from before the *first* change — t3.large is just a waypoint. One unknown per field, not one per change." |
| 2:05 | drag the playhead to the far left | "And this is the account before the agent touched it. Drag anywhere in between and you get the state at that second." |
| 2:35 | click the dashed grey card | "This one, no source could prove. Six resolvers tried, here is why each missed. It reports a question mark rather than something plausible." |
| 3:00 | type a value, **Use this value** | "You can supply it yourself — and it comes back blue, `ASSERTED`, sourced *operator-supplied*, with the tool's own note that it did not verify it." |
| 3:25 | **Simulate someone else's change**, then **press 3** | "Someone else just touched one of these fields after the plan was made. One `CONFLICT` — and the revert will refuse to clobber it." |
| 4:00 | **press 4** | "Dry run — the bar at the bottom lists the exact calls, newest change first, stop-modify-start where an instance type needs it. Nothing was called." |
| 4:25 | **press 5** | "Applied — the calls turn green, each one verified by a read-back. Four restored, the conflict skipped." |
| 4:45 | — | "Read-only by default, one mutating code path, no database, nothing running in the account, $0 on the bill." |

If you are short on time, cut the conflict beat (3:25) and the operator-supplied beat
(3:00) — in that order. The five presses plus the timeline drag still tell the whole story.

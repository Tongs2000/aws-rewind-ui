/* rewind-ui
 *
 * Every number, value and event id on screen is read out of a real `rewind` run. In demo
 * mode the server replays a recorded session against a real AWS account and hands back
 * both the parsed result and the command's verbatim output; the terminal pane shows that
 * output unedited, and the panels are a rendering of it and nothing else.
 *
 * The one thing computed here is the playhead: the value a field held at time T is the
 * `after` of the last change at or before T, or the chain's anchor when T predates the
 * first change. That is not an inference - it is the chain the plan hands over.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const UNPROVEN = "?";

const state = {
  mode: "demo",
  recorded: null,
  scan: null,
  plan: null,
  diff: null,
  revert: null,
  selected: null,
  scrubAt: null, // ms, or null for "now"
  open: {}, // collapsible group key -> open?
  auto: null, // an in-flight one-click run: {cancelled}
  stage: null,
  log: [], // {command, output} per step, for the terminal pane
};

// -- api ---------------------------------------------------------------------

/* Two transports, one surface.
 *
 * With `server/app.py` in front of the page, `/api/*` is a real POST - that is the only way
 * live mode can work, because only the server can run the CLI. Served as plain files, there
 * is no server to POST to, so the recorded session is read from `web/demo.json` instead and
 * answered in the page. The payloads are identical: the bundle is what `server/transcript.py`
 * produced, baked at build time by `demodata/bundle.py`.
 *
 * Demo mode has exactly one piece of state - whether the confirmed revert has run - so the
 * static transport is a boolean and a lookup, not a reimplementation of anything.
 */
const backend = {
  kind: null, // "server" | "static"
  bundle: null,
  applied: false,

  /** Pick a transport and return the session description. */
  async open() {
    try {
      const response = await fetch("/api/session");
      if (response.ok) {
        this.kind = "server";
        return await response.json();
      }
    } catch (error) {
      /* no server: fall through to the baked bundle */
    }
    const response = await fetch("demo.json");
    if (!response.ok) throw new Error("demo.json is missing (run demodata/bundle.py)");
    this.kind = "static";
    this.bundle = await response.json();
    return this.bundle.session;
  },

  async post(route, body) {
    if (this.kind === "server") {
      const response = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return { ok: response.ok, data: await response.json() };
    }
    return { ok: true, data: this.replay(route, body || {}) };
  },

  /** The static transport: the same six recorded commands the server hands back. */
  replay(route, body) {
    const steps = this.bundle.steps;
    switch (route) {
      case "/api/scan":
        return steps.scan;
      case "/api/plan":
        return steps.plan;
      case "/api/diff":
        // After the confirmed revert the recorded session re-ran `diff` to verify it; that
        // is the run to show, because the account has moved.
        return this.applied ? steps.verify : steps.diff;
      case "/api/revert":
        if (body.confirm) this.applied = true;
        return body.confirm ? steps.applied : steps.dryRun;
      case "/api/reset":
        this.applied = false;
        return { argv: ["# replay rewound to the start"], exitCode: 0, payload: null };
      default:
        return { argv: [], exitCode: 2, error: "not part of the recorded session: " + route };
    }
  },
};

async function call(route, body) {
  $("#cmdstatus").textContent = "running…";
  let ok, data;
  try {
    ({ ok, data } = await backend.post(route, body));
  } catch (error) {
    $("#cmdstatus").textContent = "";
    banner("could not reach the server: " + error.message, true);
    throw error;
  }
  const command = (data.argv || []).join(" ");
  if (command) $("#cmdline").textContent = "$ " + command;
  if (!ok || data.error) {
    $("#cmdstatus").textContent = "exit " + (data.exitCode ?? "?");
    banner(data.error || "the command failed", true);
    throw new Error(data.error || "command failed");
  }
  $("#cmdstatus").textContent = "exit " + data.exitCode;
  if (data.raw) {
    state.log.push({ command, output: data.raw });
    renderTerminal();
  }
  return data;
}

function banner(html, isError) {
  const node = $("#banner");
  if (!html) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.className = "banner" + (isError ? " error" : "");
  node.innerHTML = html;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// -- the driver --------------------------------------------------------------

/* One button, pressed six times, is the whole demo: the six commands the recorded session
 * actually ran, in order. Each entry says what the press asks and what it runs. */
const STEPS = [
  {
    key: "scan",
    label: "Scan CloudTrail",
    hint: "Who changed anything in this window? One row per identity, most actionable first.",
    run: () => doScan(),
  },
  {
    key: "plan",
    label: "Resolve before-values",
    hint:
      "Looks backwards: for one identity, every field it touched, what each held before it " +
      "started, and the evidence for that value. Writes the plan file.",
    run: () => doPlan(),
  },
  {
    key: "diff",
    label: "Read live state",
    hint:
      "Looks at now: reads each field's live value and compares it with what the plan says " +
      "the session left it at. Has anyone else touched it since? That is drift, and it is the " +
      "only thing that can tell 'ready to revert' from 'somebody has been here'.",
    run: () => doDiff(),
  },
  {
    key: "dryrun",
    label: "Revert — dry run",
    hint: "The exact API calls a revert would make, newest change first. Nothing is called.",
    run: () => doRevert(false),
  },
  {
    key: "confirm",
    label: "Confirm revert",
    hint: "Apply it. Each field is re-checked immediately before it is touched, and read back after.",
    run: () => confirmRevert(),
  },
  {
    key: "verify",
    label: "Verify",
    hint:
      "The same live read again, after the writes: what actually landed, what settled since, " +
      "and what still needs a human.",
    run: () => doDiff(),
  },
];

function recordedCommand(index) {
  const commands = (state.recorded && state.recorded.commands) || [];
  return commands[index] || "";
}

function markStage(stage) {
  state.stage = stage;
  const reached = STEPS.findIndex((step) => step.key === stage);
  document.querySelectorAll(".act").forEach((button) => {
    const index = STEPS.findIndex((step) => step.key === button.dataset.act);
    button.classList.toggle("done", reached >= 0 && index <= reached);
    button.classList.toggle("current", index === reached + 1);
  });
  renderDriver();
}

function nextStep() {
  const reached = STEPS.findIndex((step) => step.key === state.stage);
  return { step: STEPS[reached + 1] || null, index: reached + 1 };
}

function renderDriver() {
  const { step, index } = nextStep();
  const button = $("#next");
  const auto = $("#auto");
  const done = STEPS.findIndex((candidate) => candidate.key === state.stage) + 1;
  if (state.auto) {
    auto.textContent = "Stop  " + done + "/" + STEPS.length;
    auto.classList.add("on");
    button.disabled = true;
    $("#nexthint").textContent =
      "Running every step, " + AUTO_GAP_MS / 1000 + "s apart — this is what `rewind undo --confirm` does in one pass.";
    $("#nextcmd").textContent = "$ " + (recordedCommand(done - 1) || "");
    return;
  }
  auto.textContent = "Undo it all";
  auto.classList.remove("on");
  if (step) {
    button.textContent = step.label;
    button.disabled = false;
    button.classList.toggle("btn-final", step.key === "confirm");
    $("#nexthint").textContent = step.hint;
    $("#nextcmd").textContent = "$ " + (recordedCommand(index) || "rewind " + step.key);
  } else {
    button.textContent = "Start over";
    button.disabled = false;
    button.classList.remove("btn-final");
    $("#nexthint").textContent =
      "That is the whole run: read-only by default, one mutating path, no infrastructure, $0 on the bill.";
    $("#nextcmd").textContent = "";
  }
}

/* One click for the whole sequence, which is what `rewind undo --confirm` is: plan, diff and
 * revert in one pass. The recording does not contain an `undo` run - it was added after the
 * capture - so this replays the commands undo composes, half a second apart, and the terminal
 * pane still shows each one's own output rather than a combined report this run never printed.
 *
 * In live mode the same click would write to real resources, so it asks once, up front. */
const AUTO_GAP_MS = 500;

async function autoRun() {
  if (state.auto) {
    state.auto.cancelled = true;
    return;
  }
  if (state.mode === "live") {
    const message =
      "Run the whole sequence, ending in a confirmed revert?\n\n" +
      "This is LIVE mode: real AWS resources will be modified, with no pause between steps.";
    if (!window.confirm(message)) return;
  }
  const run = { cancelled: false };
  state.auto = run;
  renderDriver();
  try {
    if (state.stage) await resetDemo();
    for (const [index, step] of STEPS.entries()) {
      if (run.cancelled) break;
      // `confirmRevert` asks first; inside a run the operator has already said yes.
      await (step.key === "confirm" ? doRevert(true) : step.run());
      renderDriver();
      if (index < STEPS.length - 1) await sleep(AUTO_GAP_MS);
    }
  } catch (error) {
    /* already surfaced in the banner */
  } finally {
    const cancelled = run.cancelled;
    state.auto = null;
    renderDriver();
    if (cancelled) banner("Stopped. The steps already run are still on screen.");
  }
}

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function advance() {
  const { step } = nextStep();
  try {
    if (step) await step.run();
    else await resetDemo();
  } catch (error) {
    /* already surfaced in the banner */
  }
}

// -- steps -------------------------------------------------------------------

async function doScan() {
  const result = await call("/api/scan", {});
  state.scan = result.payload;
  state.plan = state.diff = state.revert = null;
  state.selected = null;
  state.scrubAt = null;
  markStage("scan");
  const scan = state.scan;
  const mine = scan.identities[0];
  banner(
    "<b>" +
      esc(scan.identitiesText || scan.identities.length + " identities") +
      "</b> in this window. Top row is the one we are chasing: <b>" +
      esc(mine.identity) +
      "</b>, " +
      mine.changes +
      " change(s) across " +
      mine.resources +
      " resource(s), " +
      esc(mine.pluginBacked) +
      " of which <b>rewind revert</b> could execute. Nothing here says what any value " +
      "<i>was</i> — that is the next step."
  );
  render();
}

async function doPlan() {
  const result = await call("/api/plan", {});
  state.plan = result.payload;
  state.diff = state.revert = null;
  state.scrubAt = null;
  markStage("plan");
  const stats = state.plan.stats;
  banner(
    "<b>" +
      esc(stats.revertibleText) +
      "</b>. Confidence: " +
      Object.entries(stats.byConfidence)
        .map(([level, count]) => count + " " + level)
        .join(", ") +
      ". Every before-value below is evidence or a question mark — never a guess." +
      ((state.plan.warnings || []).length
        ? "<ul>" + state.plan.warnings.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul>"
        : "")
  );
  render();
}

async function doDiff() {
  const result = await call("/api/diff", {});
  state.diff = result.payload;
  markStage(state.revert && !state.revert.dryRun ? "verify" : "diff");
  const summary = state.diff.summary || {};
  const parts = Object.entries(summary).map(([verdict, count]) => count + " " + verdict);
  banner(
    "<b>" +
      esc(state.diff.driftText) +
      "</b><br>" +
      parts.join(" · ") +
      (summary.UNCHECKABLE
        ? " — UNCHECKABLE means no plugin knows which Describe call reads that field, so drift cannot be checked. The change is still recorded."
        : "")
  );
  render();
}

async function doRevert(confirm) {
  const result = await call("/api/revert", { confirm: !!confirm });
  state.revert = result.payload;
  markStage(confirm ? "confirm" : "dryrun");
  const summary = state.revert.summary || {};
  const parts = Object.entries(summary).map(([outcome, count]) => count + " " + outcome);
  if (confirm) {
    banner(
      "<b>" +
        parts.join(" · ") +
        "</b>. Newest change first, each verified by a read-back." +
        (state.revert.attention.length
          ? "<ul>" +
            state.revert.attention.map((row) => "<li>" + esc(row) + "</li>").join("") +
            "</ul>"
          : ""),
      (summary.FAILED || 0) > 0
    );
  } else {
    banner("Dry run: <b>nothing was called</b>. " + parts.join(" · ") + ".");
  }
  render();
}

async function confirmRevert() {
  const message =
    "Apply the revert?\n\n" +
    (state.plan ? state.plan.stats.revertible : "?") +
    " field(s) would be written, newest change first." +
    (state.mode === "live"
      ? "\n\nThis is LIVE mode: real AWS resources will be modified."
      : "\n\nDemo mode: this replays a recorded run. Nothing is called now.");
  if (window.confirm(message)) await doRevert(true);
}

async function resetDemo() {
  await call("/api/reset", {});
  Object.assign(state, {
    scan: null,
    plan: null,
    diff: null,
    revert: null,
    selected: null,
    scrubAt: null,
    open: {},
    log: [],
  });
  markStage(null);
  renderTerminal();
  banner("Rewound to the start. Press <b>Scan CloudTrail</b>.");
  render();
}

// -- helpers -----------------------------------------------------------------

const shortResource = (id) =>
  id && id.length > 30 ? id.slice(0, 14) + "…" + id.slice(-12) : id || "";
const timeOf = (iso) => new Date(iso).getTime();
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const display = (value) => (value === null || value === undefined ? UNPROVEN : String(value));

function diffEntry(chainId) {
  if (!state.diff) return null;
  return (state.diff.entries || []).find((entry) => entry.chainId === chainId) || null;
}

function revertResult(chainId) {
  if (!state.revert) return null;
  return (state.revert.results || []).find((result) => result.chainId === chainId) || null;
}

/** Marker state for a chain, from the same single status the rest of the UI uses. */
function chainMood(chain) {
  const status = chainStatus(chain);
  if (status === "FAILED") return "failed";
  if (["REVERTED", "SUBMITTED", "ALREADY_REVERTED", "ALREADY_AT_ORIGINAL"].includes(status)) {
    return "restored";
  }
  if (["CONFLICT", "UNREADABLE"].includes(status)) return "conflict";
  if (chain.confidence === "UNKNOWN") return "unproven";
  if (chain.confidence === "ASSERTED") return "asserted";
  return "";
}

/* One status per field, from whichever step read the field last - by the clock, not by which
 * command it was. That matters at step 6: an asynchronous field the revert could only report
 * as SUBMITTED has since settled, and the verification diff is the newer read, so it wins and
 * the field reads ALREADY_REVERTED. Everything the UI groups, dims or colours keys off this,
 * so the list, the timeline, the table and the footer cannot disagree about a field. */
function diffIsNewer() {
  if (!state.diff || !state.revert) return !!state.diff;
  const wroteAt = state.revert.startedAt ? timeOf(state.revert.startedAt) : 0;
  const readAt = state.diff.checkedAt ? timeOf(state.diff.checkedAt) : 0;
  return readAt > wroteAt;
}

function latestRead(chainId) {
  const result = revertResult(chainId);
  const entry = diffEntry(chainId);
  if (!result) return { entry };
  if (!entry) return { result };
  return diffIsNewer() ? { entry, result } : { result, entry };
}

function chainStatus(chain) {
  const latest = latestRead(chain.chainId);
  // Key order is the precedence: whichever read is newer was put first.
  for (const key of Object.keys(latest)) {
    if (key === "result" && latest.result) return latest.result.outcome;
    if (key === "entry" && latest.entry && latest.entry.verdict) return latest.entry.verdict;
  }
  return chain.capability;
}

/* The statuses worth a presenter's time: something can be done, was done, or went wrong.
 * Everything else is a change rewind can only report, and is collapsed out of the way. */
const ACTIONABLE = new Set([
  "AUTO",
  "MANUAL",
  "RECONSTRUCTED",
  "REVERTIBLE",
  "DRY_RUN",
  "REVERTED",
  "SUBMITTED",
  "ALREADY_REVERTED",
  "ALREADY_AT_ORIGINAL",
  "FAILED",
  "CONFLICT",
]);

/** Why a collapsed group exists, in the CLI's terms. */
const GROUP_NOTE = {
  SKIPPED: "the previous value is not proven, so there is nothing to restore",
  DISCOVERED: "CloudTrail recorded the change but not the value it set",
  UNCHECKABLE: "no plugin knows which Describe call reads this field, so drift cannot be checked",
  UNREADABLE: "the resource cannot be read any more — it is gone",
  UNPROVEN: "the pre-session value is not proven",
};

function chainGroups() {
  const chains = state.plan ? state.plan.chains : [];
  const actionable = [];
  const rest = new Map();
  chains.forEach((chain) => {
    const status = chainStatus(chain);
    if (ACTIONABLE.has(status)) {
      actionable.push(chain);
      return;
    }
    if (!rest.has(status)) rest.set(status, []);
    rest.get(status).push(chain);
  });
  const groups = [];
  if (actionable.length) {
    groups.push({ key: "actionable", title: "Revertible & reverted", chains: actionable, open: true });
  }
  [...rest.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([status, group]) =>
      groups.push({
        key: status,
        title: status.replace(/_/g, " ").toLowerCase(),
        note: GROUP_NOTE[status] || "",
        chains: group,
        open: false,
      })
    );
  return groups;
}

/** A field is dimmed on the timeline while its group is collapsed. */
function isVisible(chain) {
  const group = chainGroups().find((candidate) => candidate.chains.includes(chain));
  if (!group) return true;
  return state.open[group.key] ?? group.open;
}

function render() {
  renderStats();
  renderTimeline();
  renderChains();
  renderEvidence();
  renderActions();
}

// -- terminal ----------------------------------------------------------------

/* The verbatim output of every command, in the order they ran. This is the receipt: if a
 * number on screen is not in here, it did not come from a rewind run. */
function renderTerminal() {
  const host = $("#termbody");
  host.innerHTML = "";
  if (!state.log.length) {
    host.appendChild(el("div", "term-empty", "No command has run yet."));
  }
  state.log.forEach((entry, index) => {
    const block = el("div", "term-block");
    const head = el("div", "term-cmd");
    head.appendChild(el("span", "term-prompt", "$"));
    head.appendChild(el("span", "term-text", entry.command));
    block.appendChild(head);
    block.appendChild(el("pre", "term-out", entry.output));
    if (index === state.log.length - 1) block.classList.add("term-latest");
    host.appendChild(block);
  });
  $("#termcount").textContent = state.log.length
    ? state.log.length + " command" + (state.log.length === 1 ? "" : "s")
    : "";
  // Keep the newest output in view without yanking the page around.
  const latest = host.querySelector(".term-latest");
  if (latest && !$("#terminal").hidden) latest.scrollIntoView({ block: "nearest" });
}

// -- stats -------------------------------------------------------------------

function renderStats() {
  const host = $("#stats");
  host.innerHTML = "";
  const cells = [];

  if (state.plan) {
    const stats = state.plan.stats;
    cells.push(["changes", stats.changes, ""]);
    cells.push(["fields", stats.chains, ""]);
    // `auto-revertible`, not `revertible`: the diff below reports its own REVERTIBLE
    // verdict, and two tiles with the same word would read as the same number twice.
    cells.push([
      "auto-revertible",
      stats.revertible + " <small>/ " + stats.chains + "</small>",
      "c-high",
    ]);
    Object.entries(stats.byConfidence).forEach(([level, count]) => {
      if (count) cells.push([level.toLowerCase(), count, "c-" + level.toLowerCase()]);
    });
  } else if (state.scan) {
    const mine = state.scan.identities[0] || {};
    cells.push(["identities", state.scan.identities.length, ""]);
    cells.push(["top identity changes", mine.changes || 0, ""]);
    cells.push(["resources", mine.resources || 0, ""]);
    cells.push(["before-values known", "0", "c-unknown"]);
  }

  // Only the tiles a presenter reads out. The counts for the collapsed groups are on the
  // group headers themselves, so repeating them here would just make a wall of numbers.
  const LOUD = {
    CONFLICT: "c-bad",
    UNREADABLE: "c-bad",
    FAILED: "c-bad",
    ALREADY_REVERTED: "c-high",
    REVERTED: "c-high",
    SUBMITTED: "c-medium",
  };
  const tile = ([key, count]) => {
    if (!count || !(key in LOUD)) return;
    cells.push([key.toLowerCase().replace(/_/g, " "), count, LOUD[key]]);
  };
  // Only the newer read's counts, for the same reason `latestRead` exists: after the
  // verification diff, "submitted 2" beside "already reverted 6" would be two answers to one
  // question. The step that reported it is still in the banner and in the terminal pane.
  if (diffIsNewer()) {
    Object.entries(state.diff.summary).forEach(tile);
  } else {
    if (state.diff) Object.entries(state.diff.summary).forEach(tile);
    if (state.revert && !state.revert.dryRun) Object.entries(state.revert.summary).forEach(tile);
  }
  if (cells.length) cells.push(["cost", "$0", ""]);

  host.hidden = cells.length === 0;
  cells.forEach(([key, value, cls]) => {
    const cell = el("div", "stat " + (cls || ""));
    cell.appendChild(el("div", "k", key));
    const node = el("div", "v");
    node.innerHTML = String(value);
    cell.appendChild(node);
    host.appendChild(cell);
  });
}

// -- timeline ----------------------------------------------------------------

/* The track is the identity's session and nothing else: one dot per change, on a real time
 * axis, left edge = the whole minute before the first change. The playhead never moves on
 * its own. The revert is a list of calls in the footer, because it is not a moment here. */

function sessionEvents() {
  if (!state.plan) return [];
  const rows = [];
  state.plan.chains.forEach((chain) =>
    chain.changes.forEach((change) =>
      rows.push({
        at: timeOf(change.eventTime),
        eventName: change.eventName,
        chain,
        change,
      })
    )
  );
  return rows.sort((a, b) => a.at - b.at);
}

function windowBounds() {
  const events = sessionEvents();
  if (!events.length || !state.plan) return null;
  const minute = 60000;
  const last = events[events.length - 1].at;
  return {
    start: Math.floor((events[0].at - minute / 2) / minute) * minute,
    end: Math.ceil((last + minute / 2) / minute) * minute,
    firstChange: events[0].at,
  };
}

function selectChain(chainId, scrollTo) {
  state.selected = chainId;
  render();
  if (scrollTo) {
    const card = document.querySelector('.chain[data-chain="' + chainId + '"]');
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderTimeline() {
  const wrap = $("#timelinewrap");
  const bounds = windowBounds();
  const events = sessionEvents();
  wrap.hidden = !bounds;
  if (!bounds) return;

  const span = bounds.end - bounds.start || 1;
  const at = state.scrubAt ?? bounds.end;
  const pct = (ms) =>
    ((Math.min(Math.max(ms, bounds.start), bounds.end) - bounds.start) / span) * 100;

  const dots = $("#dots");
  dots.innerHTML = "";
  dots.classList.toggle("focused", !!state.selected);

  // 28 changes over a quarter of an hour do not fit on a time axis without collisions -
  // one call can even change several resources at the same instant. So positions are laid
  // out in pixels with a minimum gap: each dot starts at its true time and is pushed right
  // only as far as it must be to clear its neighbour, then the tail is pulled back inside
  // the track. Order is exact and the tooltip carries the true timestamp; only the spacing
  // of a cluster is approximate, which is the trade a readable axis is worth.
  const DOT = 16;
  const GAP = DOT + 3;
  const width = $("#timeline").getBoundingClientRect().width || 1200;
  const places = [];
  events.forEach((event, index) => {
    const wanted = (pct(event.at) / 100) * width;
    places.push(index === 0 ? wanted : Math.max(wanted, places[index - 1] + GAP));
  });
  const rightEdge = width - DOT / 2;
  if (places.length && places[places.length - 1] > rightEdge) {
    for (let index = places.length - 1; index >= 0; index--) {
      const limit = index + 1 < places.length ? places[index + 1] - GAP : rightEdge;
      places[index] = Math.min(places[index], limit);
    }
  }

  events.forEach((event, index) => {
    const chain = event.chain;
    const mood = chainMood(chain);
    const dot = el(
      "div",
      "dot" +
        (event.at <= at ? " past" : "") +
        (state.selected === chain.chainId ? " linked" : "") +
        (mood ? " m-" + mood : "") +
        (isVisible(chain) ? "" : " filtered")
    );
    dot.style.left = places[index] + "px";
    dot.style.marginLeft = -DOT / 2 + "px";
    dot.textContent = index + 1;
    dot.dataset.chain = chain.chainId;

    const tip = el("div", "tip");
    tip.appendChild(el("div", "tip-head", clock(event.at) + "  " + event.eventName));
    tip.appendChild(el("div", "tip-res", chain.resourceId + " · " + chain.field));
    const value = el("div", "tip-value");
    value.appendChild(el("span", "was", display(event.change.before)));
    value.appendChild(el("span", "arrow", " → "));
    value.appendChild(el("span", "now", display(event.change.after)));
    tip.appendChild(value);
    if (chain.confidence) {
      tip.appendChild(
        el("div", "tip-res", chain.confidence + " · " + chain.capability + " · " + (chain.anchor.source || "none"))
      );
    }
    dot.appendChild(tip);
    dot.addEventListener("click", (mouse) => {
      mouse.stopPropagation();
      state.scrubAt = event.at;
      selectChain(chain.chainId, true);
    });
    dots.appendChild(dot);
  });

  $("#scrubber").style.left = pct(at) + "%";
  $("#future").style.left = pct(at) + "%";
  const readout = $("#scrubtime");
  readout.textContent =
    state.scrubAt === null ? "now" : at < bounds.firstChange ? "before the session" : clock(at);
  readout.title = new Date(at).toISOString();

  const ticks = $("#ticks");
  ticks.innerHTML = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((fraction) => {
    const tick = el("span", null, clock(bounds.start + span * fraction));
    tick.style.left = fraction * 100 + "%";
    ticks.appendChild(tick);
  });

  renderStateTable(at);
}

/** The value a field held at `at`, straight off the chain the plan handed over. */
function valueAt(chain, at) {
  let value = chain.anchor ? chain.anchor.value : null;
  let proven = !!(chain.anchor && chain.anchor.value !== null);
  for (const change of chain.changes) {
    if (timeOf(change.eventTime) <= at) {
      value = change.after;
      proven = change.after !== null;
    }
  }
  return { value, proven };
}

function renderStateTable(at) {
  const table = $("#state");
  table.innerHTML = "";
  const atNow = state.scrubAt === null;
  const bounds = windowBounds();
  const label = atNow
    ? "live now"
    : bounds && at < bounds.firstChange
    ? "before the session"
    : "at " + clock(at);

  const head = table.insertRow();
  head.className = "state-head";
  head.insertCell().outerHTML = '<td class="res">resource</td>';
  head.insertCell().outerHTML = '<td class="fld">field</td>';
  head.insertCell().outerHTML = '<td class="val">' + esc(label) + "</td>";
  head.insertCell().outerHTML =
    '<td class="now">' + (atNow ? "session left it at" : "live now") + "</td>";

  // Only fields that carry a value at all. The rest are changes CloudTrail recorded with
  // no value in them, which belong in the card list, not in a table of values.
  const valued = (state.plan ? state.plan.chains : []).filter(
    (chain) => chain.netBefore !== null || chain.netAfter !== null
  );
  valued.forEach((chain) => {
    const entry = diffEntry(chain.chainId);
    const result = revertResult(chain.chainId);
    const latest = latestRead(chain.chainId);
    const reads = Object.keys(latest).map((key) =>
      key === "result" ? (latest.result || {}).observedAfter : (latest.entry || {}).liveValue
    );
    const live = reads.find((value) => value !== null && value !== undefined) ?? chain.netAfter;
    const { value, proven } = atNow ? { value: live, proven: live !== null } : valueAt(chain, at);
    const shown = proven ? display(value) : UNPROVEN;
    const status = chainStatus(chain);
    const restored = ["REVERTED", "SUBMITTED", "ALREADY_REVERTED"].includes(status);
    const failed = status === "FAILED";

    const row = table.insertRow();
    row.insertCell().outerHTML = '<td class="res">' + esc(shortResource(chain.resourceId)) + "</td>";
    row.insertCell().outerHTML = '<td class="fld">' + esc(chain.field) + "</td>";
    let cls = proven ? "" : " q";
    if (atNow && restored) cls = " ok";
    else if (atNow && failed) cls = " bad";
    else if (!atNow && proven && shown !== display(live)) cls = " changed";
    row.insertCell().outerHTML = '<td class="val' + cls + '">' + esc(shown) + "</td>";
    const note = atNow
      ? display(chain.netAfter) + (restored ? " · ✓ restored" : failed ? " · ✗ failed" : "")
      : display(live);
    row.insertCell().outerHTML =
      '<td class="now' + (atNow && restored ? " restored" : atNow && failed ? " bad" : "") + '">' +
      esc(note) +
      "</td>";
  });
}

function attachScrubbing() {
  const track = $("#timeline");
  let dragging = false;
  const move = (mouse) => {
    const bounds = windowBounds();
    if (!bounds) return;
    const box = track.getBoundingClientRect();
    const fraction = Math.min(Math.max((mouse.clientX - box.left) / box.width, 0), 1);
    state.scrubAt = fraction > 0.995 ? null : bounds.start + (bounds.end - bounds.start) * fraction;
    renderTimeline();
  };
  track.addEventListener("mousedown", (mouse) => {
    dragging = true;
    move(mouse);
  });
  window.addEventListener("mousemove", (mouse) => dragging && move(mouse));
  window.addEventListener("mouseup", () => (dragging = false));
}

// -- the list ----------------------------------------------------------------

function renderChains() {
  const host = $("#chainlist");
  const head = $("#chainshead");
  const note = $("#chainsnote");
  host.innerHTML = "";

  if (state.plan) {
    const chains = state.plan.chains;
    head.textContent = "Changes · " + chains.length + " field(s)";
    note.innerHTML =
      "One card per field. <b>Left of the arrow is the value to restore</b>, right is what " +
      "the session set. Click a card for its evidence; its events light up on the timeline.";
    // Only what can be acted on is open. The rest are grouped by the reason they cannot be,
    // collapsed but counted - never dropped, because "reported and not hidden" is the point.
    chainGroups().forEach((group) => {
      const open = state.open[group.key] ?? group.open;
      const section = el("section", "group" + (open ? " open" : ""));
      const header = el("button", "group-head");
      header.appendChild(el("span", "caret", open ? "▾" : "▸"));
      header.appendChild(el("span", "group-title", group.title));
      header.appendChild(el("span", "group-count", String(group.chains.length)));
      if (group.note) header.appendChild(el("span", "group-note", group.note));
      header.addEventListener("click", () => {
        state.open[group.key] = !open;
        render();
      });
      section.appendChild(header);
      if (open) {
        const body = el("div", "group-body");
        group.chains.forEach((chain) => body.appendChild(chainCard(chain)));
        section.appendChild(body);
      }
      host.appendChild(section);
    });
    return;
  }

  if (state.scan) {
    head.textContent = "Identities · " + state.scan.identities.length;
    note.innerHTML =
      "Straight out of CloudTrail, one row per identity. <b>PLUGIN-BACKED</b> counts the " +
      "changes <code>rewind revert</code> could execute. No before-value exists yet — " +
      "CloudTrail does not record them.";
    state.scan.identities.forEach((row, index) => host.appendChild(identityCard(row, index)));
    return;
  }

  head.textContent = "Changes";
  note.textContent = "Press the button above to read CloudTrail.";
  const empty = el("p", "empty");
  empty.innerHTML = "Press <b>Scan CloudTrail</b> to start.";
  host.appendChild(empty);
}

function identityCard(row, index) {
  const card = el("div", "chain identity" + (index === 0 ? " primary" : ""));
  const left = el("div");
  const who = el("div", "who");
  who.innerHTML = "<b>" + esc(row.identity) + "</b>";
  left.appendChild(who);
  left.appendChild(el("div", "events", row.events));
  card.appendChild(left);

  const right = el("div", "right");
  right.appendChild(el("span", "chip steps", row.changes + " changes"));
  right.appendChild(el("span", "chip src", row.resources + " resources"));
  if (row.pluginBacked !== "-") {
    right.appendChild(el("span", "chip AUTO", row.pluginBacked + " revertible"));
  }
  card.appendChild(right);
  return card;
}

function chainCard(chain) {
  const mood = chainMood(chain);
  const unknown = chain.confidence === "UNKNOWN";
  const card = el(
    "div",
    "chain" +
      (unknown ? " unknown" : "") +
      (state.selected === chain.chainId ? " selected" : "") +
      (mood ? " m-" + mood : "")
  );
  card.dataset.chain = chain.chainId;
  card.addEventListener("mouseenter", () => highlightDots(chain.chainId, true));
  card.addEventListener("mouseleave", () => highlightDots(chain.chainId, false));

  const left = el("div");
  const who = el("div", "who");
  who.innerHTML = "<b>" + esc(chain.resourceId) + "</b> · " + esc(chain.field);
  left.appendChild(who);

  const transition = el("div", "transition");
  transition.appendChild(
    el("span", "before" + (chain.netBefore === null ? " q" : ""), display(chain.netBefore))
  );
  transition.appendChild(el("span", "arrow", "→"));
  transition.appendChild(el("span", "after", display(chain.netAfter)));
  left.appendChild(transition);
  card.appendChild(left);

  const right = el("div", "right");
  right.appendChild(el("span", "chip " + chain.confidence, chain.confidence));
  right.appendChild(el("span", "chip " + chain.capability, chain.capability));
  card.appendChild(right);

  const meta = el("div", "meta");
  if (chain.anchor.source && chain.anchor.source !== "none") {
    meta.appendChild(el("span", "chip src", chain.anchor.source));
  }
  const status = chainStatus(chain);
  const result = revertResult(chain.chainId);
  if (status !== chain.capability) {
    meta.appendChild(el("span", "chip v-" + status, status.replace(/_/g, " ")));
  }
  if (chain.revert.executable) {
    meta.appendChild(
      el("span", "hint", "revert → " + display(chain.revert.targetValue) + " via " +
        chain.revert.steps.map((step) => step.api).join(", "))
    );
  }
  if (result && result.outcome === "FAILED") {
    meta.appendChild(el("span", "hint bad", result.reason || ""));
  }
  card.appendChild(meta);

  card.addEventListener("click", () => selectChain(chain.chainId, false));
  return card;
}

function highlightDots(chainId, on) {
  document
    .querySelectorAll('#dots .dot[data-chain="' + chainId + '"]')
    .forEach((dot) => dot.classList.toggle("hover", on));
}

// -- evidence ----------------------------------------------------------------

/** The anchor reason carries every resolver that was tried and why it missed. */
function parseResolverNote(note) {
  const match = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(note || "");
  if (!match) return null;
  const parts = match[1].split("; ").map((part) => {
    const split = part.indexOf(": ");
    return split < 0 ? null : { name: part.slice(0, split), reason: part.slice(split + 2) };
  });
  const resolvers = parts.filter(Boolean);
  return resolvers.length > 1 ? resolvers : null;
}

function block(title) {
  const node = el("div", "ev-block");
  node.appendChild(el("h3", null, title));
  return node;
}

function row(key, value) {
  const node = el("div", "ev-row");
  node.appendChild(el("span", "k", key));
  node.appendChild(el("span", "v", value));
  return node;
}

function renderEvidence() {
  const host = $("#evidence");
  host.innerHTML = "";
  host.appendChild(el("h2", null, "Evidence"));

  const chain = state.plan && state.plan.chains.find((c) => c.chainId === state.selected);
  if (!chain) {
    const p = el("p", "empty");
    p.textContent = state.plan
      ? "Select a change to see exactly which event proves its previous value."
      : "Resolve before-values to see the evidence behind each one.";
    host.appendChild(p);
    return;
  }

  host.appendChild(el("div", "ev-head", chain.resourceId + "." + chain.field));
  host.appendChild(el("div", "ev-sub", chain.chainId + " · handled by " + (chain.handledBy || "—")));

  const anchor = chain.anchor || {};
  const anchorBlock = block("Previous value");
  anchorBlock.appendChild(row("value", display(anchor.value)));
  anchorBlock.appendChild(row("confidence", anchor.confidence || chain.confidence));
  anchorBlock.appendChild(row("source", anchor.source || "none"));
  (anchor.evidenceEventIds || []).forEach((id, index) =>
    anchorBlock.appendChild(row(index === 0 ? "event" : "", id))
  );
  const resolvers = parseResolverNote(anchor.reason);
  if (anchor.reason && !resolvers) anchorBlock.appendChild(el("div", "ev-note", anchor.reason));
  host.appendChild(anchorBlock);

  if (resolvers) {
    const list = block("Resolvers tried");
    const items = el("ul", "resolvers");
    resolvers.forEach((resolver) => {
      const item = el("li");
      item.appendChild(el("span", "mark", "✕"));
      const body = el("span");
      body.appendChild(el("span", "rname", resolver.name));
      body.appendChild(document.createTextNode(" — " + resolver.reason));
      item.appendChild(body);
      items.appendChild(item);
    });
    list.appendChild(items);
    const hint = el("div", "ev-note");
    hint.innerHTML = "No source could prove it, so the tool reports <b>?</b> rather than a guess.";
    list.appendChild(hint);
    host.appendChild(list);
  }

  const chainBlock = block("Change chain");
  const steps = el("ul", "steps");
  chain.changes.forEach((change) => {
    const item = el("li");
    item.innerHTML =
      '<span class="t">' +
      clock(timeOf(change.eventTime)) +
      '</span>  <span class="api">' +
      esc(change.eventName) +
      "</span>: " +
      esc(display(change.before)) +
      " → " +
      esc(display(change.after)) +
      '<br><code>' +
      esc(change.eventId) +
      "</code>";
    steps.appendChild(item);
  });
  chainBlock.appendChild(steps);
  (chain.notes || []).forEach((note) => chainBlock.appendChild(el("div", "ev-note", note)));
  host.appendChild(chainBlock);

  const revert = chain.revert || {};
  const revertBlock = block(revert.executable ? "Revert · planned calls" : "Revert · not automatic");
  if (revert.executable) {
    revertBlock.appendChild(row("target", display(revert.targetValue)));
    const calls = el("ul", "steps");
    revert.steps.forEach((step) => calls.appendChild(el("li", "api", step.api)));
    revertBlock.appendChild(calls);
  } else {
    revertBlock.appendChild(el("div", "ev-note", revert.reason || "not executable"));
  }
  if (revert.warning) revertBlock.appendChild(el("div", "ev-warn", revert.warning));
  host.appendChild(revertBlock);

  const entry = diffEntry(chain.chainId);
  if (entry) {
    const driftBlock = block("Drift check");
    driftBlock.appendChild(row("verdict", entry.verdict));
    driftBlock.appendChild(
      row("live now", display(entry.liveValue) + "  (session set " + display(entry.planAfter) + ")")
    );
    if (entry.reason) driftBlock.appendChild(el("div", "ev-note", entry.reason));
    host.appendChild(driftBlock);
  }

  const result = revertResult(chain.chainId);
  if (result) {
    const runBlock = block("Revert run");
    runBlock.appendChild(row("outcome", result.outcome));
    if (result.reason) runBlock.appendChild(el("div", "ev-note", result.reason));
    result.calls.forEach((planned) =>
      runBlock.appendChild(row("called", planned.api + (planned.note ? "  # " + planned.note : "")))
    );
    if (result.warning) runBlock.appendChild(el("div", "ev-warn", result.warning));
    host.appendChild(runBlock);
  }

  // The CLI's own words for this chain, so the panel can be checked against the terminal.
  if (chain.evidenceLines && chain.evidenceLines.length) {
    const verbatim = block("As rewind printed it");
    verbatim.appendChild(el("pre", "ev-verbatim", chain.evidenceLines.join("\n")));
    host.appendChild(verbatim);
  }
}

// -- footer ------------------------------------------------------------------

function renderActions() {
  const host = $("#actions");
  host.hidden = !state.plan;
  if (!state.plan) return;
  const stats = state.plan.stats;
  const parts = ["<b>" + stats.revertible + "</b> of <b>" + stats.chains + "</b> field(s) revertible"];
  const unprovable = stats.byConfidence.UNKNOWN;
  if (unprovable) parts.push('<span class="warn">' + unprovable + " unprovable</span>");
  if (state.revert) {
    const failed = state.revert.summary.FAILED || 0;
    parts.push(state.revert.dryRun ? "dry run complete" : "applied");
    if (failed) parts.push('<span class="bad">' + failed + " failed</span>");
  }
  $("#revertsummary").innerHTML = parts.join(" · ");
  $("#confirm").disabled = !stats.revertible;
  renderRevertCalls();
}

/* The revert is an ordered list of calls, not a moment in time, so it belongs here rather
 * than on the timeline: numbered in execution order, dashed until applied, green after. */
function renderRevertCalls() {
  const host = $("#revertcalls");
  host.innerHTML = "";
  const results = state.revert ? state.revert.results || [] : [];
  const acting = results.filter((result) => result.outcome !== "SKIPPED");
  if (!acting.length) {
    if (state.revert) host.appendChild(el("span", "call-empty", "no call to make"));
    return;
  }
  host.appendChild(
    el("span", "call-lead", state.revert.dryRun ? "would call, in order:" : "called, in order:")
  );
  acting.forEach((result, index) => {
    const applied = result.outcome === "REVERTED" || result.outcome === "SUBMITTED";
    const failed = result.outcome === "FAILED";
    const chip = el(
      "button",
      "call-chip" +
        (applied ? " applied" : "") +
        (failed ? " failed" : "") +
        (state.selected === result.chainId ? " linked" : "")
    );
    chip.appendChild(el("b", null, String(index + 1)));
    chip.appendChild(
      document.createTextNode(
        shortResource(result.resourceId) + "." + result.field + " → " + display(result.targetValue)
      )
    );
    chip.title = result.outcome.replace(/_/g, " ") + " — " + (result.reason || "");
    chip.addEventListener("click", () => selectChain(result.chainId, true));
    host.appendChild(chip);
  });
}

// -- boot --------------------------------------------------------------------

async function boot() {
  const session = await backend.open();
  state.mode = session.mode;
  state.recorded = session.recorded;
  if (session.mode === "demo") {
    // A refresh is how a presenter starts over, so the replay must be at step 0 here no
    // matter what the previous visitor left behind on the server.
    await backend.post("/api/reset", {}).catch(() => {});
  }
  $("#identity").value = session.identity || "";
  $("#region").value = session.region || "";

  const badge = $("#mode");
  badge.dataset.mode = session.mode;
  if (session.mode === "demo" && session.recorded) {
    badge.textContent = "replay · " + (session.recorded.recordedAt || "").slice(0, 10);
    badge.title = "replaying " + session.recorded.source;
    $("#sourceline").textContent =
      "replaying a recorded real run · account " +
      session.recorded.account +
      " · " +
      session.recorded.commands.length +
      " commands · nothing runs now";
    banner(
      "This is a <b>recorded real session</b> against AWS account " +
        esc(session.recorded.account) +
        ", replayed step by step: every table, value and event id below is that run's own " +
        "output, and the terminal pane keeps it verbatim. Press the amber button (or " +
        "<kbd>space</kbd>) six times."
    );
  } else {
    badge.textContent = "live · aws";
    $("#sourceline").textContent = "live mode · commands run against the ambient AWS configuration";
  }

  $("#next").addEventListener("click", () => advance());
  $("#auto").addEventListener("click", () => autoRun());
  document.querySelectorAll(".act").forEach((button) =>
    button.addEventListener("click", () => {
      if (state.auto) return;
      const step = STEPS.find((candidate) => candidate.key === button.dataset.act);
      if (step) step.run().catch(() => {});
    })
  );

  window.addEventListener("keydown", (key) => {
    const target = key.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "BUTTON")) return;
    if (key.key === " " || key.key === "ArrowRight") {
      key.preventDefault();
      if (!state.auto) advance();
    } else if (key.key === "a") {
      autoRun();
    } else if (key.key === "?") {
      $("#helpsheet").hidden = !$("#helpsheet").hidden;
    } else if (key.key === "t") {
      toggleTerminal();
    } else if (key.key === "Escape") {
      $("#helpsheet").hidden = true;
      if (state.auto) state.auto.cancelled = true;
    }
  });
  $("#help").addEventListener("click", () => ($("#helpsheet").hidden = false));
  $("#helpclose").addEventListener("click", () => ($("#helpsheet").hidden = true));
  $("#helpsheet").addEventListener("click", (mouse) => {
    if (mouse.target.id === "helpsheet") $("#helpsheet").hidden = true;
  });

  $("#confirm").addEventListener("click", () => confirmRevert().catch(() => {}));
  $("#termtoggle").addEventListener("click", toggleTerminal);
  $("#scrubreset").addEventListener("click", () => {
    state.scrubAt = null;
    renderTimeline();
  });
  $("#reset").addEventListener("click", () => resetDemo().catch(() => {}));

  attachScrubbing();
  window.addEventListener("resize", () => renderTimeline());
  markStage(null);
  renderTerminal();
  render();
}

function toggleTerminal() {
  const pane = $("#terminal");
  pane.hidden = !pane.hidden;
  $("#termtoggle").classList.toggle("on", !pane.hidden);
  if (!pane.hidden) renderTerminal();
}

boot();

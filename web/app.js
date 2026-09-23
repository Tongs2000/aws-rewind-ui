/* rewind-ui
 *
 * Every number, value and event id on screen comes from a `rewind ... --output json`
 * document. This file only lays those documents out; it never derives a previous value,
 * because the one rule the tool is built on is that an unproven value stays unproven.
 *
 * The one thing computed here is the scrubber: the value a field held at time T is the
 * `after` of the last change at or before T, or the chain's anchor when T predates the
 * first change. That is not an inference - it is exactly the chain the plan hands over.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  mode: "demo",
  scan: null,
  plan: null,
  diff: null,
  revert: null,
  account: null,
  selected: null,
  scrubAt: null, // ms, or null for "now"
  asserted: {}, // chainId -> value supplied by the operator
  stage: null,
};

const UNPROVEN = "?";

// -- api ---------------------------------------------------------------------

async function call(route, body) {
  $("#cmdstatus").textContent = "running…";
  let response, data;
  try {
    response = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    data = await response.json();
  } catch (error) {
    $("#cmdstatus").textContent = "";
    banner("could not reach the server: " + error.message, true);
    throw error;
  }
  if (data.argv) $("#cmdline").textContent = "$ " + data.argv.join(" ");
  $("#raw").textContent = JSON.stringify(data.payload ?? data, null, 2);
  if (!response.ok) {
    $("#cmdstatus").textContent = "exit " + (data.exitCode ?? "?");
    banner(data.error || "the command failed", true);
    throw new Error(data.error || "command failed");
  }
  $("#cmdstatus").textContent = "exit " + data.exitCode;
  if (data.account) state.account = data.account;
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

// -- acts --------------------------------------------------------------------

function query() {
  return {
    identity: $("#identity").value,
    since: $("#since").value,
    region: $("#region").value,
  };
}

function markStage(stage) {
  state.stage = stage;
  const reached = STEPS.findIndex((step) => step.key === stage);
  document.querySelectorAll(".act").forEach((button) => {
    const index = STEPS.findIndex((step) => step.key === button.dataset.act);
    button.classList.toggle("done", index <= reached && reached >= 0);
    button.classList.toggle("current", index === reached + 1);
  });
  renderDriver();
}

/* -- the driver ------------------------------------------------------------
 * One button, pressed five times, is the whole demo. Each entry says what the press
 * runs, what to say while it runs, and the command it maps to. */

const STEPS = [
  {
    key: "scan",
    label: "Scan CloudTrail",
    hint: "What did this identity change? CloudTrail records the value each call set — and nothing about what it replaced.",
    cmd: "rewind scan --identity … --since 90m",
    run: () => doScan(),
  },
  {
    key: "plan",
    label: "Resolve before-values",
    hint: "Chain every field back to the value it held before the session's first change, and show the evidence for each one.",
    cmd: "rewind plan --identity … --since 90m -o plan.json",
    run: () => doPlan(),
  },
  {
    key: "diff",
    label: "Check drift",
    hint: "Ask AWS what each field holds right now. Has anything moved since the plan was made?",
    cmd: "rewind diff plan.json --blame",
    run: () => doDiff(),
  },
  {
    key: "dryrun",
    label: "Revert — dry run",
    hint: "The exact API calls a revert would make, in order. Nothing is called.",
    cmd: "rewind revert plan.json",
    run: () => doRevert(false),
  },
  {
    key: "confirm",
    label: "Confirm revert",
    hint: "Apply it: newest change first, each one verified by a read-back. The only mutating path in the tool.",
    cmd: "rewind revert plan.json --confirm",
    run: () => confirmRevert(),
  },
];

function nextStep() {
  const reached = STEPS.findIndex((step) => step.key === state.stage);
  return STEPS[reached + 1] || null;
}

function renderDriver() {
  const step = nextStep();
  const button = $("#next");
  if (step) {
    button.textContent = step.label;
    button.disabled = false;
    button.classList.toggle("btn-final", step.key === "confirm");
    $("#nexthint").textContent = step.hint;
    $("#nextcmd").textContent = "$ " + step.cmd;
  } else {
    button.textContent = "Reset and run it again";
    button.disabled = false;
    button.classList.remove("btn-final");
    $("#nexthint").textContent =
      "Done: the account is back where it was before the session. Read-only by default, one mutating path, no infrastructure, $0.";
    $("#nextcmd").textContent = "";
  }
}

async function advance() {
  const step = nextStep();
  try {
    if (step) await step.run();
    else await resetDemo();
  } catch (error) {
    /* already surfaced in the banner */
  }
}

async function doScan() {
  const result = await call("/api/scan", query());
  state.scan = result.payload;
  state.plan = state.diff = state.revert = null;
  state.selected = null;
  state.scrubAt = null;
  markStage("scan");
  const scan = state.scan;
  let note =
    "CloudTrail recorded <b>" +
    scan.changes.length +
    "</b> field change(s) by this identity. Each row shows only the value the call " +
    "<i>set</i> - the previous value is not in the record. That is what step 2 resolves.";
  if (scan.otherIdentities && scan.otherIdentities.length) {
    note +=
      "<ul><li>other identities active in this window: " +
      scan.otherIdentities.map(esc).join(", ") +
      "</li></ul>";
  }
  banner(note);
  render();
}

async function doPlan() {
  const sets = Object.entries(state.asserted).map(([selector, value]) => ({ selector, value }));
  const result = await call("/api/plan", { ...query(), sets });
  state.plan = result.payload;
  state.diff = state.revert = null;
  state.scrubAt = null;
  markStage("plan");
  const warnings = state.plan.warnings || [];
  banner(
    "Previous values resolved from evidence only. <b>" +
      state.plan.stats.revertible +
      " of " +
      state.plan.stats.chains +
      "</b> field(s) can be put back." +
      (warnings.length ? "<ul>" + warnings.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul>" : "")
  );
  render();
}

async function doDiff() {
  if (!state.plan) await doPlan();
  const result = await call("/api/diff", { blame: true });
  state.diff = result.payload;
  markStage("diff");
  const summary = state.diff.summary || {};
  banner(
    state.diff.driftFree
      ? "Nothing has drifted since the plan was made: every field still holds the value the session left. The plan is safe to apply."
      : "<b>" + (summary.CONFLICT || 0) + " conflict(s)</b>: someone else changed these fields after the session, so reverting would overwrite their work.",
    !state.diff.driftFree
  );
  render();
}

async function doRevert(confirm) {
  if (!state.plan) await doPlan();
  const result = await call("/api/revert", { confirm: !!confirm });
  state.revert = result.payload;
  markStage(confirm ? "confirm" : "dryrun");
  const summary = state.revert.summary || {};
  if (confirm) {
    const done = (summary.REVERTED || 0) + (summary.SUBMITTED || 0);
    banner(
      "<b>" +
        done +
        " field(s) restored</b>, " +
        (summary.SKIPPED || 0) +
        " skipped, " +
        (summary.FAILED || 0) +
        " failed. Newest change first, each one verified by a read-back." +
        (state.mode === "demo" ? " (demo account, in memory)" : ""),
      (summary.FAILED || 0) > 0
    );
  } else {
    banner(
      "Dry run: <b>nothing was called</b>. The exact API calls are listed per field - select one to read them."
    );
  }
  render();
}

/** The confirm step, with the same prompt whether it is driven or clicked. */
async function confirmRevert() {
  if (!state.plan) await doPlan();
  const stats = state.plan.stats;
  const message =
    "Apply the revert?\n\n" +
    stats.revertible +
    " field(s) will be written, newest change first." +
    (state.mode === "live" ? "\n\nThis is LIVE mode: real AWS resources will be modified." : "");
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
    asserted: {},
  });
  markStage(null);
  banner("Demo account reset. Press <b>Scan CloudTrail</b> to start over.");
  render();
}

// -- render ------------------------------------------------------------------

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const shortResource = (id) => (id.length > 26 ? id.slice(0, 12) + "…" + id.slice(-8) : id);
const timeOf = (iso) => new Date(iso).getTime();
const clock = (ms) =>
  new Date(ms).toISOString().slice(11, 19);

function display(value) {
  if (value === null || value === undefined) return UNPROVEN;
  return String(value);
}

function render() {
  renderStats();
  renderTimeline();
  renderChains();
  renderEvidence();
  renderActions();
}

/* -- stats ----------------------------------------------------------------- */

function renderStats() {
  const host = $("#stats");
  host.innerHTML = "";
  const cells = [];

  if (state.plan) {
    const s = state.plan.stats;
    cells.push(["changes", s.changes, ""]);
    cells.push(["fields", s.chains, ""]);
    cells.push(["revertible", s.revertible + " <small>/ " + s.chains + "</small>", ""]);
    const by = s.byConfidence || {};
    ["HIGH", "MEDIUM", "ASSERTED", "UNKNOWN"].forEach((level) => {
      if (by[level]) cells.push([level.toLowerCase(), by[level], "c-" + level.toLowerCase()]);
    });
    cells.push(["events read", s.eventsConsulted, ""]);
    cells.push(["cost", "$0", ""]);
  } else if (state.scan) {
    cells.push(["events in window", state.scan.eventsInWindow, ""]);
    cells.push(["by this identity", state.scan.eventsForIdentity, ""]);
    cells.push(["field changes", state.scan.changes.length, ""]);
    cells.push(["previous values known", "0", "c-unknown"]);
  }

  if (state.diff) {
    const conflicts = state.diff.summary.CONFLICT || 0;
    cells.push(["conflicts", conflicts, conflicts ? "c-bad" : "c-high"]);
  }
  if (state.revert && !state.revert.dryRun) {
    const s = state.revert.summary;
    cells.push(["restored", (s.REVERTED || 0) + (s.SUBMITTED || 0), "c-high"]);
    if (s.FAILED) cells.push(["failed", s.FAILED, "c-bad"]);
  }

  host.hidden = cells.length === 0;
  cells.forEach(([key, value, cls]) => {
    const cell = el("div", "stat " + (cls || ""));
    cell.appendChild(el("div", "k", key));
    const v = el("div", "v");
    v.innerHTML = String(value);
    cell.appendChild(v);
    host.appendChild(cell);
  });
}

/* -- timeline -------------------------------------------------------------- */

function sessionEvents() {
  if (state.plan) {
    const rows = [];
    state.plan.chains.forEach((chain) =>
      chain.changes.forEach((change) =>
        rows.push({
          at: timeOf(change.eventTime),
          eventName: change.eventName,
          resourceId: chain.resourceId,
          field: chain.field,
          after: change.after,
          chainId: chain.chainId,
        })
      )
    );
    return rows.sort((a, b) => a.at - b.at);
  }
  if (state.scan) {
    return state.scan.changes
      .map((change) => ({
        at: timeOf(change.eventTime),
        eventName: change.eventName,
        resourceId: change.resourceId,
        field: change.field,
        after: change.setTo,
        chainId: null,
      }))
      .sort((a, b) => a.at - b.at);
  }
  return [];
}

function windowBounds() {
  const events = sessionEvents();
  const source = state.plan || state.scan;
  if (!events.length || !source) return null;
  // The axis starts on the whole minute before the first change, so the tick labels read
  // 17:20:00 / 17:22:30 / … rather than an arbitrary 17:20:59, and the first dot is not
  // clipped by the left edge. Anywhere left of `firstChange` is "before the session".
  const minute = 60000;
  return {
    start: Math.floor((events[0].at - minute / 2) / minute) * minute,
    end: timeOf(source.query.endTime),
    firstChange: events[0].at,
  };
}

/* The track is the agent's session and nothing else: one dot per change, on a real time
 * axis, left edge = the instant before the agent touched anything. The playhead never
 * moves on its own - it sits at "now" until you drag it or click a dot. Anchors are read
 * off the state table by dragging to the left edge, and the revert is a list of calls in
 * the footer, because neither of those is a moment inside the session. */

function selectChain(chainId, scrollTo) {
  state.selected = chainId;
  render();
  if (scrollTo) {
    const card = document.querySelector('.chain[data-chain="' + chainId + '"]');
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** Marker state for a chain, so every zone tells the same story about it. */
function chainMood(chain) {
  if (revertOutcome(chain.chainId) === "REVERTED" || revertOutcome(chain.chainId) === "SUBMITTED") {
    return "restored";
  }
  if (diffVerdict(chain.chainId) === "CONFLICT") return "conflict";
  if (chain.confidence === "UNKNOWN") return "unproven";
  if (chain.confidence === "ASSERTED") return "asserted";
  return "";
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
  // When a card is selected, its own dots stay lit and the rest fade back: the link
  // between the list and the timeline has to be visible, not just implied.
  dots.classList.toggle("focused", !!state.selected);

  const chains = state.plan ? state.plan.chains : [];

  // One call can change the same field on several resources at the same instant -
  // MonitorInstances takes a list - so dots that land on the same pixel are spread
  // symmetrically around it rather than stacked on top of each other. The apparent time
  // error is a few seconds; being unreadable is worse.
  const places = events.map((event) => pct(event.at));
  const crowd = new Map();
  places.forEach((place, index) => {
    const key = place.toFixed(1);
    if (!crowd.has(key)) crowd.set(key, []);
    crowd.get(key).push(index);
  });
  // The nudge is in pixels, not percent: a dot is 16px wide at any viewport width, so a
  // percentage offset that clears it on a wide screen still overlaps on a narrow one.
  const DOT = 16;
  const nudge = (index) => {
    const group = crowd.get(places[index].toFixed(1));
    const seat = group.indexOf(index);
    return (seat - (group.length - 1) / 2) * (DOT + 3);
  };

  events.forEach((event, index) => {
    const chain = chains.find((candidate) => candidate.chainId === event.chainId);
    const mood = chain ? chainMood(chain) : "";
    const linked = state.selected && event.chainId === state.selected;
    const dot = el(
      "div",
      "dot" + (event.at <= at ? " past" : "") + (linked ? " linked" : "") + (mood ? " m-" + mood : "")
    );
    dot.style.left = places[index] + "%";
    dot.style.marginLeft = -DOT / 2 + nudge(index) + "px";
    dot.textContent = index + 1;
    if (event.chainId) dot.dataset.chain = event.chainId;
    const tip = el("div", "tip");
    tip.appendChild(el("div", "tip-head", clock(event.at) + "  " + event.eventName));
    tip.appendChild(el("div", "tip-res", event.resourceId + " · " + event.field));
    const value = el("div", "tip-value");
    // Before-values only exist once `plan` has run; scan cannot know them.
    const before = chain ? valueAt(chain, event.at - 1) : null;
    if (before) {
      value.appendChild(el("span", "was", before.proven ? display(before.value) : UNPROVEN));
      value.appendChild(el("span", "arrow", " → "));
    }
    value.appendChild(el("span", "now", display(event.after)));
    tip.appendChild(value);
    dot.appendChild(tip);
    dot.addEventListener("click", (mouse) => {
      mouse.stopPropagation();
      state.scrubAt = event.at;
      if (event.chainId) selectChain(event.chainId, true);
      else render();
    });
    dots.appendChild(dot);
  });

  $("#scrubber").style.left = pct(at) + "%";
  $("#future").style.left = pct(at) + "%";
  const readout = $("#scrubtime");
  readout.textContent =
    state.scrubAt === null ? "now" : at < bounds.firstChange ? "before the session" : clock(at);
  // The full instant stays available without spending a line of the layout on it.
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
  let value = chain.anchor && chain.anchor.value !== null ? chain.anchor.value : null;
  let proven = !(chain.anchor && chain.anchor.value === null);
  for (const change of chain.changes) {
    if (timeOf(change.eventTime) <= at) {
      value = change.after;
      proven = true;
    }
  }
  return { value, proven };
}

function stateHeader(table, label, rightLabel) {
  const row = table.insertRow();
  row.className = "state-head";
  row.insertCell().outerHTML = '<td class="res">resource</td>';
  row.insertCell().outerHTML = '<td class="fld">field</td>';
  row.insertCell().outerHTML = '<td class="val">' + esc(label) + "</td>";
  row.insertCell().outerHTML = '<td class="now">' + esc(rightLabel) + "</td>";
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
  stateHeader(table, label, atNow ? "session left it at" : "live now");

  if (!state.plan) {
    // Scan only: CloudTrail gives the value each call set and nothing earlier.
    const seen = new Map();
    sessionEvents().forEach((event) => {
      const key = event.resourceId + "." + event.field;
      if (event.at <= at) seen.set(key, event);
      else if (!seen.has(key)) seen.set(key, null);
    });
    [...seen.entries()].forEach(([key, event]) => {
      const [resource, field] = key.split(/\.(?=[^.]+$)/);
      const row = table.insertRow();
      row.insertCell().outerHTML = '<td class="res">' + esc(shortResource(resource)) + "</td>";
      row.insertCell().outerHTML = '<td class="fld">' + esc(field) + "</td>";
      row.insertCell().outerHTML =
        '<td class="val' + (event ? "" : " q") + '">' + esc(event ? display(event.after) : UNPROVEN) + "</td>";
      row.insertCell().outerHTML =
        '<td class="now">' + (event ? "set by " + esc(event.eventName) : "not set yet in this window") + "</td>";
    });
    return;
  }

  state.plan.chains.forEach((chain) => {
    const live = liveValue(chain.chainId);
    const nowValue = live !== null ? live : display(chain.netAfter);
    // Scrubbed back: the value the chain says the field held then. Parked at "now": the
    // live value, which is the only thing that stays true after a revert has run.
    const { value, proven } = atNow ? { value: nowValue, proven: true } : valueAt(chain, at);
    const shown = proven ? display(value) : UNPROVEN;
    const row = table.insertRow();
    row.insertCell().outerHTML = '<td class="res">' + esc(shortResource(chain.resourceId)) + "</td>";
    row.insertCell().outerHTML = '<td class="fld">' + esc(chain.field) + "</td>";
    const restored = revertOutcome(chain.chainId) === "REVERTED";
    let valueClass = proven ? "" : " q";
    if (atNow && restored) valueClass = " ok";
    else if (!atNow && proven && shown !== nowValue) valueClass = " changed";
    row.insertCell().outerHTML = '<td class="val' + valueClass + '">' + esc(shown) + "</td>";
    row.insertCell().outerHTML =
      '<td class="now' + (atNow && restored ? " restored" : "") + '">' +
      esc(atNow ? display(chain.netAfter) : nowValue) +
      (atNow && restored ? " · ✓ restored" : "") +
      "</td>";
  });
}

function liveValue(chainId) {
  if (state.revert) {
    const result = (state.revert.results || []).find((r) => r.chainId === chainId);
    if (result && result.observedAfter !== null && result.observedAfter !== undefined) {
      return result.observedAfter;
    }
  }
  if (state.diff) {
    const entry = (state.diff.entries || []).find((e) => e.chainId === chainId);
    if (entry) return display(entry.liveValue);
  }
  return null;
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

/* -- chain cards ----------------------------------------------------------- */

function renderChains() {
  const host = $("#chainlist");
  const head = $("#chainshead");
  const note = $("#chainsnote");
  host.innerHTML = "";

  if (state.plan) {
    head.textContent = "Changes · " + state.plan.stats.chains + " field(s)";
    note.innerHTML =
      "One card per field. <b>Left of the arrow is the value to restore</b>, right is where the " +
      "field sits now. Click a card: its events light up on the timeline and the evidence " +
      "appears on the right.";
    state.plan.chains.forEach((chain) => host.appendChild(chainCard(chain)));
    return;
  }
  if (state.scan) {
    head.textContent = "Events · " + state.scan.changes.length + " field change(s)";
    note.innerHTML =
      "Straight out of CloudTrail: the value each call <i>set</i>. Every before-value is " +
      "<b>?</b> because the record does not contain it — that is what the next step resolves.";
    state.scan.changes.forEach((change, index) => host.appendChild(scanCard(change, index)));
    return;
  }
  head.textContent = "Changes";
  note.textContent = "One row per field the identity touched. Click a row to see its evidence.";
  host.appendChild(
    (() => {
      const p = el("p", "empty");
      p.innerHTML = "Run <b>Scan</b> to read CloudTrail for this identity and window.";
      return p;
    })()
  );
}

function scanCard(change, index) {
  const card = el("div", "chain");
  const left = el("div");
  left.appendChild(
    (() => {
      const who = el("div", "who");
      who.innerHTML = "<b>" + esc(change.resourceId) + "</b> · " + esc(change.field);
      return who;
    })()
  );
  const transition = el("div", "transition");
  transition.appendChild(el("span", "before q", UNPROVEN));
  transition.appendChild(el("span", "arrow", "→"));
  transition.appendChild(el("span", "after", display(change.setTo)));
  left.appendChild(transition);
  card.appendChild(left);

  const right = el("div", "right");
  right.appendChild(el("span", "chip steps", clock(timeOf(change.eventTime))));
  right.appendChild(el("span", "chip src", change.eventName));
  card.appendChild(right);

  card.addEventListener("click", () => {
    state.scrubAt = timeOf(change.eventTime);
    render();
  });
  return card;
}

function chainCard(chain) {
  const unknown = chain.confidence === "UNKNOWN";
  const card = el("div", "chain" + (unknown ? " unknown" : "") + (state.selected === chain.chainId ? " selected" : ""));
  card.dataset.chain = chain.chainId;
  // Hovering a card previews the link to the timeline before you commit a click.
  card.addEventListener("mouseenter", () => highlightDots(chain.chainId, true));
  card.addEventListener("mouseleave", () => highlightDots(chain.chainId, false));

  const left = el("div");
  const who = el("div", "who");
  who.innerHTML = "<b>" + esc(chain.resourceId) + "</b> · " + esc(chain.field);
  left.appendChild(who);

  const transition = el("div", "transition");
  const beforeClass =
    "before" + (unknown ? " q" : "") + (chain.confidence === "ASSERTED" ? " asserted" : "");
  transition.appendChild(el("span", beforeClass, display(chain.netBefore)));
  transition.appendChild(el("span", "arrow", "→"));
  transition.appendChild(el("span", "after", display(chain.netAfter)));
  left.appendChild(transition);
  card.appendChild(left);

  const right = el("div", "right");
  right.appendChild(el("span", "chip " + chain.confidence, chain.confidence));
  if (chain.anchor && chain.anchor.source && chain.anchor.source !== "none") {
    right.appendChild(el("span", "chip src", chain.anchor.source));
  }
  card.appendChild(right);

  const meta = el("div", "meta");
  meta.appendChild(
    el("span", "chip steps", chain.changeCount + (chain.changeCount === 1 ? " step" : " steps"))
  );
  // A revert outcome supersedes the diff verdict it was based on; showing both just
  // says the same thing twice.
  const outcome = revertOutcome(chain.chainId);
  const verdict = outcome ? null : diffVerdict(chain.chainId);
  if (verdict) meta.appendChild(el("span", "chip v-" + verdict, verdict.replace(/_/g, " ")));
  if (outcome) meta.appendChild(el("span", "chip v-" + outcome, outcome.replace(/_/g, " ")));
  if (chain.changeCount > 1) {
    // Only the intermediate values: the last one is where the field sits now, and the
    // first is the target, so neither belongs in "passed through on the way".
    const path = chain.changes.slice(0, -1).map((change) => display(change.after));
    meta.appendChild(el("span", "hint", "via " + path.join(" → ") + " — not the revert target"));
  }
  card.appendChild(meta);

  if (unknown) card.appendChild(supplyRow(chain));

  card.addEventListener("click", (mouse) => {
    if (mouse.target.closest(".supply")) return;
    state.selected = chain.chainId;
    render();
  });
  return card;
}

function supplyRow(chain) {
  const row = el("div", "supply");
  const input = el("input");
  input.placeholder = "the real previous value";
  input.value = state.asserted[chain.chainId] || "";
  const apply = el("button", "btn btn-primary", "Use this value");
  apply.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    state.asserted[chain.chainId] = value;
    state.selected = chain.chainId;
    await doPlan();
  });
  const hint = el("span", "hint");
  hint.innerHTML =
    "no resolver could prove this &mdash; supplying it records <b>ASSERTED</b>, never proof";
  row.append(input, apply, hint);
  return row;
}

function highlightDots(chainId, on) {
  document
    .querySelectorAll('#dots .dot[data-chain="' + chainId + '"]')
    .forEach((dot) => dot.classList.toggle("hover", on));
}

function diffVerdict(chainId) {
  if (!state.diff) return null;
  const entry = (state.diff.entries || []).find((e) => e.chainId === chainId);
  return entry ? entry.verdict : null;
}

function revertOutcome(chainId) {
  if (!state.revert) return null;
  const result = (state.revert.results || []).find((r) => r.chainId === chainId);
  return result ? result.outcome : null;
}

/* -- evidence -------------------------------------------------------------- */

/** The anchor note carries every resolver that was tried and why it missed. */
function parseResolverNote(note) {
  const match = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(note || "");
  if (!match) return null;
  return match[1]
    .split("; ")
    .map((part) => {
      const split = part.indexOf(": ");
      if (split < 0) return null;
      return { name: part.slice(0, split), reason: part.slice(split + 2) };
    })
    .filter(Boolean);
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

  const head = el("div", "ev-head", chain.resourceId + "." + chain.field);
  const sub = el("div", "ev-sub", chain.chainId + " · " + chain.operation);
  host.append(head, sub);

  // anchor
  const anchor = chain.anchor || {};
  const anchorBlock = block("Previous value");
  anchorBlock.appendChild(row("value", display(anchor.value)));
  anchorBlock.appendChild(row("confidence", anchor.confidence || chain.confidence));
  anchorBlock.appendChild(row("source", anchor.source || "none"));
  (anchor.evidenceEventIds || []).forEach((id, index) =>
    anchorBlock.appendChild(row(index === 0 ? "event" : "", id))
  );
  const resolvers = parseResolverNote(anchor.note);
  if (anchor.note && !resolvers) {
    anchorBlock.appendChild(el("div", "ev-note", anchor.note));
  }
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
    hint.innerHTML =
      "No source could prove it, so the tool reports <b>?</b> rather than a plausible guess.";
    list.appendChild(hint);
    host.appendChild(list);
  } else if (anchor.source && anchor.source !== "none") {
    const list = block("Resolver chain");
    const items = el("ul", "resolvers");
    ["response-elements", "config-history", "local-snapshot", "cloudtrail-window", "creation-event", "operator-supplied"].forEach(
      (name) => {
        const hit = name === anchor.source;
        const item = el("li", hit ? "hit" : "");
        item.appendChild(el("span", "mark", hit ? "✓" : "·"));
        const body = el("span");
        body.appendChild(el("span", "rname", name));
        if (hit) body.appendChild(document.createTextNode(" — " + (anchor.note || "proved the value")));
        item.appendChild(body);
        items.appendChild(item);
      }
    );
    list.appendChild(items);
    host.appendChild(list);
  }

  // the chain itself
  const chainBlock = block("Change chain");
  const chainList = el("ul", "steps");
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
    chainList.appendChild(item);
  });
  chainBlock.appendChild(chainList);
  (chain.notes || []).forEach((note) => chainBlock.appendChild(el("div", "ev-note", note)));
  host.appendChild(chainBlock);

  // revert
  const revert = chain.revert || {};
  const revertBlock = block(revert.executable ? "Revert · planned calls" : "Revert · not possible");
  if (revert.executable) {
    revertBlock.appendChild(row("target", display(revert.targetValue)));
    const steps = el("ul", "steps");
    (revert.steps || []).forEach((step) => {
      const item = el("li");
      item.innerHTML =
        '<span class="api">' +
        esc(step.api) +
        "</span><br><code>" +
        esc(JSON.stringify(step.params)) +
        "</code>" +
        (step.condition ? '<br><span class="cond">' + esc(step.condition) + "</span>" : "") +
        (step.waitFor ? '<br><span class="cond">wait for ' + esc(step.waitFor) + "</span>" : "");
      steps.appendChild(item);
    });
    revertBlock.appendChild(steps);
    if (revert.verify) {
      revertBlock.appendChild(
        row("verify", revert.verify.api + " expect " + display(revert.verify.expect))
      );
    }
    if (revert.warning) revertBlock.appendChild(el("div", "ev-warn", revert.warning));
  } else {
    revertBlock.appendChild(el("div", "ev-note", revert.reason || "not executable"));
  }
  host.appendChild(revertBlock);

  const result = state.revert && (state.revert.results || []).find((r) => r.chainId === chain.chainId);
  if (result) {
    const outcomeBlock = block("Last run");
    outcomeBlock.appendChild(row("outcome", result.outcome));
    outcomeBlock.appendChild(row("reason", result.reason || ""));
    if (result.observedBefore !== null && result.observedBefore !== undefined) {
      outcomeBlock.appendChild(row("observed", display(result.observedBefore) + " → " + display(result.observedAfter)));
    }
    (result.calls || result.plannedCalls || []).forEach((planned) =>
      outcomeBlock.appendChild(row("call", planned.api))
    );
    host.appendChild(outcomeBlock);
  }
}

/* -- footer ---------------------------------------------------------------- */

function renderActions() {
  const host = $("#actions");
  host.hidden = !state.plan;
  if (!state.plan) return;
  const stats = state.plan.stats;
  const parts = [
    "<b>" + stats.revertible + "</b> of <b>" + stats.chains + "</b> field(s) revertible",
  ];
  if (stats.unprovable) parts.push('<span class="warn">' + stats.unprovable + " unprovable</span>");
  if (state.diff && !state.diff.driftFree) {
    parts.push('<span class="warn">' + (state.diff.summary.CONFLICT || 0) + " conflict(s)</span>");
  }
  if (state.revert) {
    parts.push(state.revert.dryRun ? "dry run complete" : "applied");
  }
  $("#revertsummary").innerHTML = parts.join(" · ");
  $("#confirm").disabled = stats.revertible === 0;
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
    const chip = el(
      "button",
      "call-chip" + (applied ? " applied" : "") + (state.selected === result.chainId ? " linked" : "")
    );
    chip.appendChild(el("b", null, String(index + 1)));
    chip.appendChild(
      document.createTextNode(shortResource(result.resourceId) + "." + result.field + " → " + display(result.targetValue))
    );
    chip.title =
      result.outcome.replace(/_/g, " ").toLowerCase() + " — " + (result.reason || "");
    chip.addEventListener("click", () => selectChain(result.chainId, true));
    host.appendChild(chip);
  });
}

// -- boot --------------------------------------------------------------------

async function boot() {
  const session = await (await fetch("/api/session")).json();
  state.mode = session.mode;
  state.account = session.account;
  $("#mode").textContent = session.mode === "demo" ? "demo · fixture" : "live · aws";
  $("#mode").dataset.mode = session.mode;
  $("#identity").value = session.identity || "";
  $("#region").value = session.region || "";
  $("#since").value = session.since || "90m";
  $("#reset").hidden = session.mode !== "demo";
  if (session.mode === "demo") {
    banner(
      "Demo mode: a sanitized CloudTrail fixture and an in-memory account. No AWS " +
        "credentials are used and no call leaves this machine. Press the amber button " +
        "(or <kbd>space</kbd>) five times to walk the whole story."
    );
  }

  $("#next").addEventListener("click", () => advance());
  document.querySelectorAll(".act").forEach((button) =>
    button.addEventListener("click", () => {
      const step = STEPS.find((candidate) => candidate.key === button.dataset.act);
      if (step) step.run().catch(() => {});
    })
  );

  // Space advances the demo, so a presenter never has to find the cursor. Typing in a
  // field must still type, and the buttons keep their own Enter/Space behaviour.
  window.addEventListener("keydown", (key) => {
    const target = key.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "BUTTON")) return;
    if (key.key === " " || key.key === "ArrowRight") {
      key.preventDefault();
      advance();
    } else if (key.key === "?") {
      $("#helpsheet").hidden = !$("#helpsheet").hidden;
    } else if (key.key === "Escape") {
      $("#helpsheet").hidden = true;
    }
  });
  $("#help").addEventListener("click", () => ($("#helpsheet").hidden = false));
  $("#helpclose").addEventListener("click", () => ($("#helpsheet").hidden = true));
  $("#helpsheet").addEventListener("click", (mouse) => {
    if (mouse.target.id === "helpsheet") $("#helpsheet").hidden = true;
  });

  $("#dryrun").addEventListener("click", () => doRevert(false).catch(() => {}));
  $("#confirm").addEventListener("click", () => confirmRevert().catch(() => {}));
  $("#rawtoggle").addEventListener("click", () => ($("#raw").hidden = !$("#raw").hidden));
  $("#scrubreset").addEventListener("click", () => {
    state.scrubAt = null;
    renderTimeline();
  });
  $("#tamper").hidden = session.mode !== "demo";
  $("#tamper").addEventListener("click", async () => {
    const result = await call("/api/tamper", {});
    const what = result.payload;
    banner(
      "A third party just set <b>" +
        esc(what.resource) +
        "." +
        esc(what.field) +
        "</b> to <b>" +
        esc(what.value) +
        "</b>, after the plan was made. Press <b>Check drift</b>: the plan is now stale for " +
        "that field and reverting it would overwrite work that is not the agent's."
    );
    state.diff = null;
    state.revert = null;
    // Rewind the driver so the next press is the drift check, which is the point.
    markStage("plan");
    render();
  });

  $("#reset").addEventListener("click", () => resetDemo().catch(() => {}));
  document.querySelectorAll(".query input").forEach((input) =>
    input.addEventListener("keydown", (key) => {
      if (key.key === "Enter") doScan().catch(() => {});
    })
  );

  attachScrubbing();
  markStage(null);
  render();
}

boot();

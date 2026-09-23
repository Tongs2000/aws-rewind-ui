/* End-to-end UI test: drives the real page against a running server in jsdom.
 *
 *   cd /tmp && mkdir -p rwtest && cd rwtest && npm i jsdom
 *   cp <repo>/dev/smoke.mjs . && node smoke.mjs        # server must be running
 *
 * Checks the demo as a presenter would walk it: five presses of the driver button, the
 * evidence panel for a proved and an unproved field, supplying a value, the scrubber, the
 * card/timeline link, and the conflict beat. Fails loudly if any JS error fires.
 */

import { JSDOM } from "jsdom";

const BASE = process.env.REWIND_UI || "http://127.0.0.1:8787";
const errors = [];

const html = await (await fetch(BASE + "/")).text();
const js = await (await fetch(BASE + "/app.js")).text();
const css = await (await fetch(BASE + "/app.css")).text();

/* Rules whose absence silently wrecks the layout rather than throwing: a missing
 * `.tip { display: none }` dumps every tooltip onto the axis, a missing `.ticks`
 * collapses five timestamps into one run of digits, a missing `.scrubber` makes the
 * playhead invisible. Editing CSS by block deletion has taken these out before. */
const REQUIRED_CSS = [
  ".dot .tip", ".dot:hover .tip", ".ticks", ".ticks span",
  ".scrubber", ".scrubber .handle",
  ".state td", ".state tr.state-head td",
  ".call-chip", "[hidden]",
];
const missingCss = REQUIRED_CSS.filter((rule) => !css.includes(rule));
if (missingCss.length) errors.push("app.css lost these rules: " + missingCss.join(", "));
console.log("css rules        :", missingCss.length ? "MISSING " + missingCss.join(", ") : "all present");

const dom = new JSDOM(html, { runScripts: "outside-only", url: BASE + "/", pretendToBeVisual: true });
const { window } = dom;
window.fetch = (url, opts) => fetch(new URL(url, BASE).href, opts);
window.onerror = (m) => errors.push("onerror: " + m);
window.addEventListener("error", (e) => errors.push("error event: " + e.message));
window.confirm = () => true;
window.HTMLElement.prototype.scrollIntoView = () => {};

try {
  window.eval(js);
} catch (e) {
  errors.push("eval: " + e.stack);
}

const d = window.document;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => (d.querySelector(sel) || {}).textContent?.replace(/\s+/g, " ").trim();
const click = async (sel, ms = 700) => {
  const node = d.querySelector(sel);
  if (!node) return errors.push("missing element " + sel);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(ms);
};
const press = async (key, ms = 700) => {
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
  await wait(ms);
};
const chips = () => [...d.querySelectorAll('[class*="chip v-"]')].map((n) => n.textContent).join(", ");
const driver = () => text("#next") + "  |  " + text("#nextcmd");

/* What the demo adds as it advances: dots from step 1, dot moods from step 3, revert call
 * chips in the footer at step 4, turning green at step 5. The playhead never moves on its
 * own, so its readout should stay at "now" throughout. */
const zones = () =>
  "dots=" +
  d.querySelectorAll("#dots .dot").length +
  " moods=[" +
  [...new Set([...d.querySelectorAll("#dots .dot")].flatMap((n) =>
    (n.className.match(/m-\w+/g) || [])))].join(",") +
  "] calls=" +
  d.querySelectorAll("#revertcalls .call-chip").length +
  " applied=" +
  d.querySelectorAll("#revertcalls .call-chip.applied").length +
  " playhead=" +
  text("#scrubtime");
/** Same-row overlap between two absolutely positioned markers means one is unreadable.
 * Resolved at several viewport widths, because `left` is a percentage while the dot
 * nudge that separates same-instant events is in pixels. */
const overlaps = (selector, fixedWidthPx) => {
  const hits = [];
  for (const viewport of [1000, 1440, 1920]) {
    const track = viewport * 0.96;
    const boxes = [...d.querySelectorAll(selector)].map((n) => {
      const left = (parseFloat(n.style.left) / 100) * track + (parseFloat(n.style.marginLeft) || 0);
      const width = n.style.maxWidth ? (parseFloat(n.style.maxWidth) / 100) * track : fixedWidthPx;
      return { left, right: left + width, row: n.style.top || "css", label: n.textContent.slice(0, 8) };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.row === b.row && a.left < b.right && b.left < a.right) {
          hits.push(viewport + "px:" + a.label + "/" + b.label);
        }
      }
    }
  }
  return hits;
};

await wait(600);
console.log("mode       :", text("#mode"));
console.log("driver     :", driver());
console.log("hint       :", text("#nexthint"));

// ---- the five presses, via the keyboard, as a presenter would
for (let step = 1; step <= 5; step++) {
  await press(" ", step === 5 ? 1300 : 900);
  console.log("\n== press " + step + " ==");
  console.log("ran        :", text("#cmdline"));
  console.log("next       :", driver());
  console.log("acts done  :", [...d.querySelectorAll(".act.done")].map((n) => n.textContent.trim()).join(" "),
              "| current:", text(".act.current"));
  console.log("banner     :", (text("#banner") || "").slice(0, 150));
  console.log("timeline   :", zones());
  if (step === 1) {
    console.log("cards      :", d.querySelectorAll("#chainlist .chain").length,
                "| dots:", d.querySelectorAll("#dots .dot").length);
    console.log("note       :", text("#chainsnote"));
  }
  if (step === 2) {
    console.log("stats      :", text("#stats"));
    console.log("unknown    :", d.querySelectorAll(".chain.unknown").length);
  }
  if (step >= 3) console.log("chips      :", chips());
  if (step === 5) console.log("state      :", text("#state"));
}
console.log("\nafter 5 presses, driver:", driver());
/* The axis must carry nothing but the numbers: a dot's own text is its index, and every
 * detail waits in a tooltip. A missing `.tip { display: none }` dumps the whole tooltip
 * onto the track and makes the timeline unreadable, so assert it rather than trust it. */
const leaked = [...d.querySelectorAll("#dots .dot")].filter((dot) => {
  const own = [...dot.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
  return !/^\d+$/.test(own.trim()) || !dot.querySelector(".tip");
});
console.log("dot labels       :", [...d.querySelectorAll("#dots .dot")]
  .map((n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join("")).join(" "));
if (leaked.length) errors.push(leaked.length + " dot(s) show more than their number on the axis");

const ticks = [...d.querySelectorAll("#ticks span")];
console.log("axis ticks       :", ticks.map((n) => n.textContent + "@" + n.style.left).join("  "));
if (new Set(ticks.map((n) => n.style.left)).size !== ticks.length) {
  errors.push("axis tick labels are not spread across the track");
}

const clashes = overlaps("#dots .dot", 16);
console.log("dot overlaps     :", clashes.length ? clashes.join(" ") : "none at 1000/1440/1920px");
if (clashes.length) errors.push("timeline dots overlap and are unreadable: " + clashes.join(" "));

// the playhead is a manual control: five presses must leave it sitting at "now"
console.log("playhead         :", text("#scrubtime"), "| table column:", text("#state .state-head td.val"));
if (text("#scrubtime") !== "now") errors.push("the playhead moved on its own: " + text("#scrubtime"));
console.log("revert calls     :", text("#revertcalls"));

// ---- card <-> timeline link
await click("#reset");
await press(" ");
await press(" ");
const card = d.querySelector('.chain[data-chain]');
const chainId = card.dataset.chain;
card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);
console.log("\n-- link check for", chainId);
console.log("dots focused    :", d.querySelector("#dots").classList.contains("focused"));
console.log("linked dots     :", d.querySelectorAll("#dots .dot.linked").length,
            "of", d.querySelectorAll("#dots .dot").length);
console.log("selected cards  :", d.querySelectorAll(".chain.selected").length);
console.log("evidence head   :", text("#evidence .ev-head"), "/", text("#evidence .ev-sub"));

// hover preview
card.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
await wait(100);
console.log("hovered dots    :", d.querySelectorAll("#dots .dot.hover").length);

// clicking a dot selects its card and moves the scrubber
const otherDot = [...d.querySelectorAll("#dots .dot")].find((n) => n.dataset.chain !== chainId);
otherDot.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);
console.log("dot click -> selected:", d.querySelector(".chain.selected")?.dataset.chain,
            "| scrub:", text("#scrubtime"));

// ---- unproved field: evidence, then supply a value
const unknown = d.querySelector(".chain.unknown");
unknown.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);
console.log("\n-- UNKNOWN evidence");
console.log("resolver rows   :", d.querySelectorAll("#evidence .resolvers li").length);
console.log("panel           :", text("#evidence").slice(0, 330));
unknown.querySelector(".supply input").value = "t3.nano";
unknown.querySelector(".supply .btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(900);
console.log("after --set     :", text("#cmdline"));
console.log("asserted chips  :", [...d.querySelectorAll(".chip.ASSERTED")].map((n) => n.textContent).join(","));

// ---- scrubber
const timeline = d.querySelector("#timeline");
timeline.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 54 });
timeline.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 0 }));
window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 0 }));
window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
await wait(200);
console.log("\n-- scrubbed to session start");
console.log("at              :", text("#scrubtime"));
console.log("state           :", text("#state"));
await click("#scrubreset");
console.log("after 'back to now':", text("#scrubtime"));

// ---- help sheet
await press("?", 150);
console.log("\nhelp visible    :", !d.querySelector("#helpsheet").hidden);
await press("Escape", 150);
console.log("help dismissed  :", d.querySelector("#helpsheet").hidden);

// ---- conflict beat
await click("#reset");
await press(" ");
await press(" ");
await click("#tamper");
console.log("\n-- TAMPER");
console.log("banner          :", text("#banner"));
console.log("driver rewound  :", driver());
await press(" ");
console.log("after drift     :", text("#banner"));
console.log("chips           :", chips());
await press(" ");
console.log("dry run chips   :", chips());
console.log("footer          :", text("#revertsummary"));

console.log("\nJS ERRORS:", errors.length ? errors : "none");
process.exitCode = errors.length ? 1 : 0;

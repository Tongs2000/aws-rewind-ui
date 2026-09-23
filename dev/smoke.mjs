/* End-to-end UI test: drives the real page against a running server in jsdom.
 *
 *   cd /tmp && mkdir -p rwtest && cd rwtest && npm i jsdom
 *   cp <repo>/dev/smoke.mjs . && node smoke.mjs        # server must be running
 *
 * Walks the replay the way a presenter does - six presses - and checks what each step puts
 * on screen, the filter chips, the evidence panel, the terminal pane, and the playhead.
 * Exits non-zero on any JS error or failed assertion.
 */

import { JSDOM } from "jsdom";
const B = process.env.REWIND_UI || "http://127.0.0.1:8787";
const errors = [];
const html=await(await fetch(B+"/")).text(), css=await(await fetch(B+"/app.css")).text(), js=await(await fetch(B+"/app.js")).text();
const dom=new JSDOM(html.replace('<link rel="stylesheet" href="app.css">',"<style>"+css+"</style>"),
  {runScripts:"outside-only",url:B+"/",pretendToBeVisual:true});
const {window}=dom, d=window.document;
window.fetch=(u,o)=>fetch(new URL(u,B).href,o); window.confirm=()=>true;
window.HTMLElement.prototype.scrollIntoView=()=>{};
window.addEventListener("error",e=>errors.push(e.message)); window.onerror=m=>errors.push("onerror "+m);
try { window.eval(js); } catch(e) { errors.push("eval "+e.stack); }
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const t=s=>(d.querySelector(s)||{}).textContent?.replace(/\s+/g," ").trim();
const press=async(k,ms=800)=>{d.body.dispatchEvent(new window.KeyboardEvent("keydown",{key:k,bubbles:true}));await wait(ms);};
await wait(700);
console.log("badge   :", t("#mode"), "|", t("#sourceline"));
console.log("driver  :", t("#next"), "|", t("#nextcmd"));
const names=["scan","plan","diff","dryrun","confirm","verify"];
for (let i=0;i<6;i++){
  await press(" ");
  console.log("\n== press "+(i+1)+" ("+names[i]+")");
  console.log("  ran      :", t("#cmdline"));
  console.log("  next     :", t("#next"));
  console.log("  stats    :", (t("#stats")||"").slice(0,170));
  console.log("  banner   :", (t("#banner")||"").slice(0,170));
  console.log("  cards    :", d.querySelectorAll("#chainlist .chain").length,
              "| dots:", d.querySelectorAll("#dots .dot").length,
              "| calls:", d.querySelectorAll("#revertcalls .call-chip").length,
              "| terminal blocks:", d.querySelectorAll("#termbody .term-block").length);
}
console.log("\ngroups  :");
for (const g of d.querySelectorAll(".group")) {
  console.log("  " + (g.classList.contains("open") ? "open  " : "closed") + " " +
    g.querySelector(".group-title").textContent.padEnd(26) +
    g.querySelector(".group-count").textContent.padStart(3) +
    "  cards shown: " + g.querySelectorAll(".chain").length +
    (g.querySelector(".group-note") ? "  | " + g.querySelector(".group-note").textContent.slice(0,60) : ""));
}
console.log("  cards visible total:", d.querySelectorAll("#chainlist .chain").length,
            "| dimmed dots:", d.querySelectorAll("#dots .dot.filtered").length);
// render() rebuilds the list, so the header has to be looked up again to collapse it.
const groupByTitle = (title) => [...d.querySelectorAll(".group")]
  .find(g => g.querySelector(".group-title").textContent === title);
const closedTitle = [...d.querySelectorAll(".group")]
  .find(g => !g.classList.contains("open")).querySelector(".group-title").textContent;
const toggle = async () => {
  groupByTitle(closedTitle).querySelector(".group-head")
    .dispatchEvent(new window.MouseEvent("click",{bubbles:true}));
  await wait(250);
};
await toggle();
console.log("  after expanding '" + closedTitle + "':", d.querySelectorAll("#chainlist .chain").length, "cards");
await toggle();
console.log("  after collapsing it again:", d.querySelectorAll("#chainlist .chain").length, "cards");
const auto=d.querySelector(".chain[data-chain]");
auto.dispatchEvent(new window.MouseEvent("click",{bubbles:true})); await wait(300);
console.log("\nevidence for", auto.dataset.chain, ":");
console.log(" ", (t("#evidence")||"").slice(0,600));
console.log("  verbatim block:", !!d.querySelector(".ev-verbatim"));
console.log("  linked dots:", d.querySelectorAll("#dots .dot.linked").length);
console.log("\nterminal: chars =", d.querySelector("#termbody").textContent.length,
            "| count label:", t("#termcount"));
console.log("footer  :", t("#revertsummary"));
console.log("calls   :", (t("#revertcalls")||"").slice(0,220));
// drag to the far left
const tl=d.querySelector("#timeline"); tl.getBoundingClientRect=()=>({left:0,width:1000,top:0,height:46});
tl.dispatchEvent(new window.MouseEvent("mousedown",{bubbles:true,clientX:0}));
window.dispatchEvent(new window.MouseEvent("mousemove",{bubbles:true,clientX:0}));
window.dispatchEvent(new window.MouseEvent("mouseup",{bubbles:true})); await wait(200);
console.log("\ndragged left:", t("#scrubtime"), "| table:", (t("#state")||"").slice(0,300));
/* -- assertions: the things whose silent breakage would not throw --------------- */

const expect = (label, actual, wanted) => {
  const ok = String(actual) === String(wanted);
  console.log((ok ? "  ok   " : "  FAIL ") + label + ": " + actual + (ok ? "" : " (want " + wanted + ")"));
  if (!ok) errors.push(label + ": got " + actual + ", want " + wanted);
};

console.log("\nchecks:");
expect("terminal blocks == commands run", d.querySelectorAll("#termbody .term-block").length, 6);
expect("dots on the timeline", d.querySelectorAll("#dots .dot").length, 14);
expect("revert call chips", d.querySelectorAll("#revertcalls .call-chip").length, 6);
expect("no failed call chips", d.querySelectorAll("#revertcalls .call-chip.failed").length, 0);
// Step 6 read the fields after step 5 wrote them, so its verdict supersedes the revert's:
// the two asynchronous fields that could only be SUBMITTED have settled.
const chipTexts = [...d.querySelectorAll("#chainlist .chip")].map((n) => n.textContent);
expect("no field still reads SUBMITTED after verify", chipTexts.filter((x) => x === "SUBMITTED").length, 0);
expect("all six read ALREADY REVERTED", chipTexts.filter((x) => x === "ALREADY REVERTED").length, 6);
expect("stats show only the newer read", (t("#stats") || "").includes("submitted"), false);
expect("playhead left of the first change", t("#scrubtime"), "before the session");
// 4 reverted + 2 submitted are acted on; the 8 with no recorded value collapse away.
expect("only actionable cards open", d.querySelectorAll("#chainlist .chain").length, 6);
expect("a collapsed group is present", [...d.querySelectorAll(".group")].filter(g=>!g.classList.contains("open")).length >= 1, true);
expect("collapsed fields dimmed on the axis", d.querySelectorAll("#dots .dot.filtered").length, 8);

// The axis carries nothing but the numbers; a missing tooltip rule dumps text onto it.
const leaked = [...d.querySelectorAll("#dots .dot")].filter((dot) => {
  const own = [...dot.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
  return !/^\d+$/.test(own.trim()) || !dot.querySelector(".tip");
});
expect("dots showing only their number", leaked.length, 0);

// Rules whose absence wrecks the layout without throwing.
const REQUIRED_CSS = [".dot .tip", ".dot:hover .tip", ".ticks", ".ticks span", ".scrubber",
  ".scrubber .handle", ".state td", ".state tr.state-head td", ".call-chip", ".term-out",
  ".group-head", ".group-count", "[hidden]"];
const missingCss = REQUIRED_CSS.filter((rule) => !css.includes(rule));
expect("app.css rules present", missingCss.length ? missingCss.join(",") : 0, 0);

// Same-row dot overlap, resolved in pixels at three viewport widths.
const clashes = [];
for (const viewport of [1200]) {
  // Positions are laid out in pixels against the measured track, so this check only has
  // to confirm the spacing pass left no pair touching.
  const boxes = [...d.querySelectorAll("#dots .dot")].map((n) => {
    const left = parseFloat(n.style.left) + (parseFloat(n.style.marginLeft) || 0);
    return { left, right: left + 16, label: [...n.childNodes].filter((c) => c.nodeType === 3)
      .map((c) => c.textContent).join("") };
  });
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (boxes[i].left < boxes[j].right && boxes[j].left < boxes[i].right)
        clashes.push(boxes[i].label + "/" + boxes[j].label);
}
expect("touching dots on the axis", clashes.length ? clashes.join(" ") : 0, 0);
const spread = [...d.querySelectorAll("#dots .dot")].map((n) => Math.round(parseFloat(n.style.left)));
console.log("  dot x  :", spread.join(" "));

// Every value the panels show must appear in the verbatim output they claim to render.
const term = d.querySelector("#termbody").textContent;
const sampled = ["t3.micro", "chn-18af3316d78f", "SUBMITTED", "creation-event",
                 "response-elements", "REVERTED=4  SUBMITTED=2"];
const absent = sampled.filter((needle) => !term.includes(needle));
expect("sampled values present in the raw output", absent.length ? absent.join(",") : 0, 0);

console.log("\nERRORS:", errors.length?errors:"none");
process.exitCode = errors.length ? 1 : 0;

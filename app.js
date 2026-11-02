import {
  loadKey, saveKey, requestDeviceCode, pollDeviceToken, fetchCatalog, fetchBalance, makeCallChat,
} from "./lib/pollen.js";
import { runSteps, decide, totalPollen, ROLES } from "./lib/job.js";
import { initTower } from "./lib/tower3d.js";

const STORE_KEY = "receipts-tower-state-v1";
const $ = (id) => document.getElementById(id);

/** DOM builder. Text always goes through textContent: model replies are untrusted. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(6) : "n/a");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ state */

let cfg;
let floors = [];
let tower = null;
let selected = null;
let busy = false;
let rentOpen = false;
const session = { token: loadKey(), ids: new Set(), rates: {}, catalogOk: false };
let store = loadStore();

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validRound = (r) => isObj(r) && Array.isArray(r.steps) && isObj(r.outputs);
const validJob = (j) => validRound(j) && Array.isArray(j.revisions) && j.revisions.every(validRound);

/** Saved state is only trusted if every job has the shape the views read; bad entries are dropped. */
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (isObj(s) && isObj(s.jobs)) {
      const jobs = {};
      for (const [id, j] of Object.entries(s.jobs)) if (validJob(j)) jobs[id] = j;
      return { jobs, applications: Array.isArray(s.applications) ? s.applications.filter(isObj) : [] };
    }
  } catch { /* fresh start */ }
  return { jobs: {}, applications: [] };
}
/** True when the browser accepted the write. */
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ connection */

function renderConn() {
  const on = !!session.token;
  $("conn-status").textContent = on ? "Connected: live jobs spend your own Pollen" : "Not connected: recorded jobs only";
  $("btn-connect").hidden = on;
  $("btn-connect").disabled = signingIn;
  $("btn-disconnect").hidden = !on;
  $("btn-disconnect").disabled = busy; // a run in flight keeps using the key it started with
}

async function refreshCatalog() {
  session.ids = new Set();
  session.rates = {};
  session.catalogOk = false;
  const cat = await fetchCatalog({ token: session.token });
  if (cat.ok) { session.ids = cat.ids; session.rates = cat.rates; session.catalogOk = true; }
}

let signinAbort = null;
let signingIn = false;
async function connect() {
  if (signingIn) return;
  signingIn = true;
  renderConn();
  try {
    await runSignin();
  } finally {
    signingIn = false;
    renderConn();
  }
}

async function runSignin() {
  const start = await requestDeviceCode();
  if (!start.ok) { setConnNote(start.error.message); return; }
  setConnNote("");
  $("signin-code").textContent = start.userCode;
  const link = $("signin-link");
  link.href = /^https:\/\/enter\.pollinations\.ai\//.test(start.verificationUriComplete) ? start.verificationUriComplete : "https://enter.pollinations.ai/";
  $("signin-wait").textContent = "Waiting for approval…";
  $("signin").hidden = false;
  $("signin-link").focus();
  const ctl = new AbortController();
  signinAbort = ctl;
  let interval = start.interval;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (!ctl.signal.aborted && Date.now() < deadline) {
    await sleep(interval * 1000);
    if (ctl.signal.aborted) return;
    const r = await pollDeviceToken({ deviceCode: start.deviceCode, interval });
    if (ctl.signal.aborted) return; // cancelled while the poll was in flight: do not keep the key
    if (r.ok) {
      session.token = r.token;
      saveKey(r.token);
      $("signin").hidden = true;
      signingIn = false;
      renderConn();
      await refreshCatalog();
      renderFloor();
      return;
    }
    if (!r.pending) { $("signin-wait").textContent = r.error.message; return; }
    interval = r.interval;
  }
  if (!ctl.signal.aborted) $("signin-wait").textContent = "The sign-in request expired. Start again.";
}

function setConnNote(t) { if (t) $("conn-status").textContent = t; else renderConn(); }

function disconnect() {
  if (busy) return;
  session.token = "";
  saveKey("");
  session.ids = new Set();
  session.rates = {};
  renderConn();
  renderFloor();
}

/* ------------------------------------------------------------------ jobs */

const currentJob = () => (selected ? store.jobs[selected.id] : null);
const allSteps = (job) => [...job.steps, ...(job.revisions || []).flatMap((r) => r.steps)];

function roundsOf(job) {
  return [{ label: "Job", steps: job.steps, outputs: job.outputs }, ...(job.revisions || []).map((r, i) => ({ label: `Revision ${i + 1}`, note: r.note, recorded: !!r.recorded, steps: r.steps, outputs: r.outputs }))];
}
const latestOutputs = (job) => roundsOf(job).at(-1).outputs;

async function fetchRecorded(id) {
  try {
    const res = await fetch(`recorded/${encodeURIComponent(id)}.json`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * Run one action that must not overlap another (a paid run, a replay, a revision).
 * `busy` is set before the first await and always cleared, even when the action throws.
 */
async function exclusive(action) {
  if (busy) return;
  const act = focusedAct();
  busy = true;
  noteText = "";
  renderConn();
  renderFloor();
  announce("Working…");
  try {
    await action();
    announce("Done. The receipt is below the owner inbox.");
  } catch (e) {
    noteText = (e && e.message) || String(e);
    announce(noteText);
  } finally {
    busy = false;
    if (!saveStore() && !noteText) noteText = "This browser would not save your progress; it stays until you leave the page.";
    renderConn();
    renderAll();
    refocus(act);
  }
}

/** Re-rendering replaces the buttons, so remember which action button had focus and restore it. */
const focusedAct = () => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.act : "") || "";
function refocus(act) {
  if (!act) return;
  const el = document.querySelector(`[data-act="${act}"]`);
  if (el && !el.disabled) el.focus();
}
function announce(text) { $("live-status").textContent = text; }

function playRecorded(floor) {
  return exclusive(async () => {
    const rec = await fetchRecorded(floor.id);
    if (!rec || !Array.isArray(rec.steps) || !isObj(rec.outputs)) throw new Error("This recorded run could not be loaded.");
    const job = { mode: "recorded", at: rec.recordedAt, steps: [], outputs: {}, decision: null, revisions: [] };
    store.jobs[floor.id] = job;
    for (const step of rec.steps) {
      job.steps.push(step);
      if (rec.outputs[step.role]) job.outputs[step.role] = rec.outputs[step.role];
      renderFloor();
      if (!reduced) await sleep(450);
    }
  });
}

async function runLive(floor, { roles = ROLES, prior = {}, ownerNote = "", into }) {
  const callChat = makeCallChat({ token: session.token });
  return runSteps({
    cfg, floor, roles, prior, ownerNote, callChat, availableIds: session.ids, rates: session.rates,
    onStep: (_s, steps) => { into.steps = steps.slice(); renderFloor(); },
  });
}

function startLive(floor) {
  if (!session.token) return Promise.resolve();
  return exclusive(async () => {
    const before = await fetchBalance({ token: session.token });
    const job = { mode: "live", at: new Date().toISOString(), steps: [], outputs: {}, decision: null, revisions: [], balanceBefore: before };
    store.jobs[floor.id] = job;
    renderFloor();
    const run = await runLive(floor, { into: job });
    job.steps = run.steps;
    job.outputs = run.outputs;
    job.failed = run.failed;
    await finishLive(job);
  });
}

async function finishLive(job) {
  await sleep(2500); // the balance catches up a moment after the call
  const after = await fetchBalance({ token: session.token });
  job.balanceAfter = after;
}

function onDecision(action, note) {
  const job = currentJob();
  if (!job || busy) return Promise.resolve();
  const d = decide(action, note);
  if (d.status === "needs-note") { setNote("Write what you want changed first."); return Promise.resolve(); }
  if (d.status === "approved" || d.status === "held") {
    const act = focusedAct();
    noteText = "";
    job.decision = { status: d.status, at: new Date().toISOString() };
    saveStore();
    renderAll();
    refocus(act);
    announce(d.status === "approved" ? "Approved." : "On hold.");
    return Promise.resolve();
  }
  if (d.status !== "revising") return Promise.resolve();
  return exclusive(async () => {
    if (job.mode === "recorded") {
      const rec = await fetchRecorded(selected.id);
      if (!rec || !rec.revision || !validRound(rec.revision)) throw new Error("Only Kimchi Club has a recorded revision. Connect your Pollen to revise this one live.");
      job.revisions.push({ note: rec.revision.note, recorded: true, steps: rec.revision.steps, outputs: rec.revision.outputs });
      job.decision = { status: "revised", at: new Date().toISOString() };
      return;
    }
    const prior = latestOutputs(job);
    const round = { note: d.ownerNote, steps: [], outputs: prior };
    job.revisions.push(round);
    renderFloor();
    const run = await runLive(selected, { roles: d.rerun, prior, ownerNote: d.ownerNote, into: round });
    round.steps = run.steps;
    round.outputs = run.outputs;
    round.failed = run.failed;
    if (!run.failed) job.decision = { status: "revised", at: new Date().toISOString() };
    await finishLive(job);
  });
}

/* ------------------------------------------------------------------ views */

let noteText = "";
function setNote(t) { const act = focusedAct(); noteText = t; renderFloor(); refocus(act); announce(t); }

function renderList() {
  const ol = $("floor-list");
  ol.replaceChildren();
  for (const f of [...floors].reverse()) {
    const job = store.jobs[f.id];
    let sub = f.tagline;
    if (job) sub = `${job.decision ? job.decision.status : "waiting for the owner"} · ${job.mode} · ${fmt(totalPollen(allSteps(job)).known)} Pollen`;
    const b = h("button", { type: "button", style: `--floor:${f.color}`, "aria-current": selected && selected.id === f.id ? "true" : "false", onclick: () => pick(f.id, true) },
      h("span", { class: "name" }, `Floor ${f.number} · ${f.name}`),
      h("span", { class: "sub" }, sub));
    ol.append(h("li", {}, b));
  }
}

function stepNode(step) {
  const meta = [];
  if (step.model) meta.push(step.model);
  if (step.usage) meta.push(`${step.usage.prompt_tokens} in / ${step.usage.completion_tokens} out`);
  if (step.attempts > 1) meta.push("retried once (bad JSON)");
  const li = h("li", { class: "step" + (step.error || !step.output ? " err" : "") },
    h("header", {}, h("span", { class: "role" }, step.role), h("span", { class: "meta" }, meta.join(" · ")),
      step.standIn ? h("span", { class: "badge stand", title: "The agent is not public yet, so the base model ran with the same role prompt." }, "stand-in model") : null),
    step.error ? h("p", { class: "errtext" }, step.error) : null,
    !step.error && !step.output ? h("p", { class: "errtext" }, "The agent did not return valid JSON.") : null,
    step.output ? h("pre", {}, JSON.stringify(step.output, null, 2)) : step.raw ? h("pre", {}, step.raw) : null);
  return li;
}

function receiptNode(job) {
  const rows = [];
  for (const round of roundsOf(job)) {
    for (const s of round.steps) {
      rows.push(h("tr", {}, h("td", {}, `${round.label} · ${s.role}`), h("td", {}, (s.model || "").replace("community/patbing/", "agent ")),
        h("td", { class: "num" }, s.usage ? String(s.usage.prompt_tokens) : "-"), h("td", { class: "num" }, s.usage ? String(s.usage.completion_tokens) : "-"),
        h("td", { class: "num" }, typeof s.estPollen === "number" ? fmt(s.estPollen) : "rate unknown")));
    }
  }
  const t = totalPollen(allSteps(job));
  const measured = job.mode === "live" && typeof job.balanceBefore === "number" && typeof job.balanceAfter === "number"
    ? job.balanceBefore - job.balanceAfter : null;
  return h("section", { class: "receipt", "aria-label": "Receipt" },
    h("h3", {}, "Receipt"),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Step"), h("th", {}, "Called"), h("th", { class: "num" }, "In"), h("th", { class: "num" }, "Out"), h("th", { class: "num" }, "Est. Pollen"))),
      h("tbody", {}, rows),
      h("tfoot", {}, h("tr", {}, h("td", { colspan: 4 }, "Estimated total"), h("td", { class: "num" }, fmt(t.known))))),
    t.unknown ? h("p", { class: "note" }, `${t.unknown} step(s) have no published rate, so the total is a lower bound.`) : null,
    measured !== null ? h("p", { class: "note" }, `Measured from your balance: ${fmt(measured)} Pollen (balance read before and after; it can lag a moment).`)
      : job.mode === "live" ? h("p", { class: "note" }, "Your key cannot read the balance, so only the estimate is shown.") : null,
    h("p", { class: "note" }, "Estimate = token counts × the live per-token rates from the model list. " +
      (job.mode === "recorded" ? "This run was recorded on the owner's account; running it live spends your own Pollen." : "Spent from your own Pollen.")));
}

function inboxNode(job) {
  const out = latestOutputs(job);
  const rv = out.reviewer;
  if (!rv) return null;
  const ds = job.decision;
  const area = h("textarea", { id: "revise-note", "aria-label": "What should change?", placeholder: "What should change? (needed to ask for a revision)" });
  const lock = busy;
  return h("section", { class: "inbox", "aria-label": "Owner inbox" },
    h("h3", {}, "Owner inbox"),
    h("p", { class: "muted" }, `${selected.ownerRole} Reviewer says: ${rv.verdict || "n/a"}.`),
    h("p", { class: "q" }, String(rv.decisionQuestion || "Approve this deliverable?")),
    Array.isArray(rv.issues) && rv.issues.length ? h("ul", {}, rv.issues.map((i) => h("li", {}, String(i)))) : null,
    Array.isArray(rv.options) && rv.options.length ? h("p", { class: "muted" }, `Options: ${rv.options.join(" / ")}${rv.recommended ? ` · recommended: ${rv.recommended}` : ""}`) : null,
    ds ? h("p", { class: `status ${ds.status}` }, ds.status === "approved" ? "Approved by the owner." : ds.status === "held" ? "On hold." : "Revision requested; the writer and reviewer ran again.") : null,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", "data-act": "approve", disabled: lock, onclick: () => onDecision("approve") }, "Approve"),
      h("button", { type: "button", class: "btn", "data-act": "hold", disabled: lock, onclick: () => onDecision("hold") }, "Hold"),
      h("button", { type: "button", class: "btn", "data-act": "revise", disabled: lock, onclick: () => onDecision("revise", area.value) }, "Request revision")),
    area,
    noteText ? h("p", { class: "alert", role: "status" }, noteText) : null);
}

function renderFloor() {
  const view = $("floor-view");
  if (rentOpen) { view.hidden = true; return; }
  view.hidden = false;
  if (!selected) { view.replaceChildren(h("p", { class: "muted" }, "Pick a floor to step into its office.")); return; }
  const f = selected;
  const job = currentJob();
  const live = !!session.token;
  const nodes = [
    h("h2", {}, `Floor ${f.number} · ${f.name}`),
    h("p", { class: "tagline" }, f.tagline),
    h("p", { class: "fact" }, h("b", {}, "The company: "), f.brief),
    h("p", { class: "fact" }, h("b", {}, "Today's task: "), f.task),
    h("p", { class: "fact muted" }, f.ownerRole),
    h("div", { class: "actions" },
      live
        ? h("button", { type: "button", class: "btn primary", "data-act": "run", disabled: busy, onclick: () => startLive(f) }, job ? "Run this job again (spends your Pollen)" : "Run this job (spends your Pollen)")
        : h("button", { type: "button", class: "btn primary", "data-act": "run", disabled: busy, onclick: () => playRecorded(f) }, job ? "Replay the recorded run" : "Play the recorded run"),
      job ? h("span", { class: `badge ${job.mode === "live" ? "live" : "rec"}` }, job.mode === "live" ? "live run" : `recorded ${String(job.at || "").slice(0, 10)}, real agent output`) : null,
      !live ? h("span", { class: "muted" }, "Connect your Pollen to run it live.") : null),
    noteText && !(job && latestOutputs(job).reviewer) ? h("p", { class: "alert", role: "status" }, noteText) : null,
  ];
  if (job) {
    for (const round of roundsOf(job)) {
      nodes.push(h("h3", {}, round.label), round.note ? h("p", { class: "muted" }, round.recorded ? `Owner's note in the recording (your text was not sent): ${round.note}` : `Owner's note: ${round.note}`) : null, h("ol", { class: "steps" }, round.steps.map(stepNode)));
    }
    const w = latestOutputs(job).writer;
    if (w) nodes.push(h("h3", {}, "Deliverable"), h("div", { class: "deliver" }, h("h4", {}, String(w.title || "Untitled")), h("p", {}, String(w.body || ""))));
    nodes.push(inboxNode(job), receiptNode(job));
  }
  view.replaceChildren(...nodes.filter(Boolean));
}

function renderRent() {
  const v = $("rent-view");
  v.hidden = !rentOpen;
  if (!rentOpen) return;
  const name = h("input", { id: "r-name", maxlength: 60, required: true });
  const what = h("textarea", { id: "r-what", rows: 4, maxlength: 600, required: true, placeholder: "What should the three agents do for you every week?" });
  const contact = h("input", { id: "r-contact", maxlength: 80, placeholder: "Optional: how the tower owner can reach you" });
  const msg = h("p", { class: "muted", role: "status" });
  const form = h("form", { class: "form", onsubmit: (e) => {
    e.preventDefault();
    const app = { floor: floors.length + 1, company: name.value.trim(), job: what.value.trim(), contact: contact.value.trim(), createdAt: new Date().toISOString() };
    if (!app.company || !app.job) { msg.textContent = "Add a company name and what the agents should do."; return; }
    store.applications.push(app);
    const kept = saveStore();
    const blob = new Blob([JSON.stringify(app, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `office-application-${app.floor}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg.textContent = (kept ? "Saved in this browser and downloaded" : "Downloaded (this browser would not keep a copy)") + " as a JSON file. Send the file to the tower owner: nothing was uploaded.";
    form.reset();
  } },
    h("label", {}, "Company name", name), h("label", {}, "What the agents do", what), h("label", {}, "Contact", contact),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, "Save application"), h("button", { type: "button", class: "btn", onclick: () => { rentOpen = false; renderAll(); $("btn-rent").focus(); } }, "Back to the tower")),
    msg);
  v.replaceChildren(h("h2", {}, `Rent Floor ${floors.length + 1}`),
    h("p", { class: "muted" }, `A rented floor gets a researcher, a writer and a reviewer, plus an owner inbox like the floors below. ${store.applications.length} application(s) saved in this browser.`), form);
}

function renderAll() { renderList(); renderFloor(); $("rent-view").hidden = !rentOpen; }

function pick(id, keepFocus = false) {
  if (busy) return;
  const f = floors.find((x) => x.id === id);
  if (!f) return;
  selected = f;
  rentOpen = false;
  noteText = "";
  history.replaceState(null, "", `#floor=${encodeURIComponent(id)}`);
  if (tower) tower.select(floors.indexOf(f));
  renderAll();
  announce(`Floor ${f.number}, ${f.name}.`);
  if (keepFocus) { const cur = $("floor-list").querySelector('[aria-current="true"]'); if (cur) cur.focus(); }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    const [a, f] = await Promise.all([fetch("data/agents.json").then((r) => r.json()), fetch("data/floors.json").then((r) => r.json())]);
    cfg = a;
    floors = f.floors;
  } catch {
    $("floor-view").textContent = "Could not load the tower data. Reload the page.";
    return;
  }
  try {
    $("btn-connect").addEventListener("click", connect);
    $("btn-disconnect").addEventListener("click", disconnect);
    $("btn-signin-cancel").addEventListener("click", () => { if (signinAbort) signinAbort.abort(); $("signin").hidden = true; });
    $("btn-rent").addEventListener("click", () => { rentOpen = true; renderAll(); renderRent(); $("panel").focus(); });
    tower = initTower($("stage"), floors, (i) => pick(floors[i].id));
    if (!tower) { $("stage").hidden = true; $("stage-hint").hidden = true; }
    renderConn();
    if (session.token) await refreshCatalog();
    pick(floorFromHash());
    addEventListener("hashchange", () => { const id = floorFromHash(); if (!selected || selected.id !== id) pick(id); });
  } catch (e) {
    $("floor-view").textContent = "The tower could not start. Reload the page.";
    console.error(e);
  }
}

/** The floor named in the URL hash, or the first floor. Never throws on a malformed hash. */
function floorFromHash() {
  let wanted = "";
  try { wanted = decodeURIComponent((location.hash.match(/(?:^#|&)floor=([^&]+)/) || [])[1] || ""); } catch { /* malformed escape */ }
  return floors.some((x) => x.id === wanted) ? wanted : floors[0].id;
}

boot();

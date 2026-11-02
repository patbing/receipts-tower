// Creates the three private role agents (if missing) and records one real job per floor.
// Needs a key with account:keys. The key is read here and never printed or written.
//   node tools/record.mjs [--dry]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { API_BASE, makeCallChat, fetchCatalog, fetchBalance } from "../lib/pollen.js";
import { runSteps, decide, agentModelId, ROLES } from "../lib/job.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(root, "data/agents.json"), "utf8"));
const floors = JSON.parse(readFileSync(path.join(root, "data/floors.json"), "utf8")).floors;
const dry = process.argv.includes("--dry");
const CAP = 0.04; // stop if the balance drops by more than this many Pollen

function loadKey() {
  const k = (process.env.POLLINATIONS_API_KEY || "").trim();
  if (!k) throw new Error("set POLLINATIONS_API_KEY (a key with account:keys) before running this script");
  return k;
}
const token = loadKey();
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(API_BASE + p, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

let updated = false;
async function ensureAgents() {
  const list = await api("GET", "/account/agents");
  if (list.status !== 200) throw new Error(`GET /account/agents -> ${list.status} ${list.text}`);
  const byName = new Map((list.json.data || []).map((a) => [a.name, a]));
  for (const role of ROLES) {
    const a = cfg.agents[role];
    const cur = byName.get(a.name);
    if (cur) {
      // keep the live agent in step with data/agents.json
      if (cur.systemPrompt === a.systemPrompt && cur.baseModel === cfg.baseModel) { console.log("agent up to date:", a.name); continue; }
      if (dry) { console.log("[dry] would update", a.name); continue; }
      const u = await api("PATCH", `/account/agents/${cur.id}`, { systemPrompt: a.systemPrompt, baseModel: cfg.baseModel, title: a.title, description: a.description });
      if (u.status !== 200) throw new Error(`update ${a.name} -> ${u.status} ${u.text}`);
      console.log("agent updated:", a.name);
      updated = true;
      continue;
    }
    if (dry) { console.log("[dry] would create", a.name); continue; }
    const r = await api("POST", "/account/agents", {
      name: a.name, title: a.title, description: a.description, visibility: "private",
      systemPrompt: a.systemPrompt, baseModel: cfg.baseModel, mcpServers: [],
    });
    if (r.status !== 200) throw new Error(`create ${a.name} -> ${r.status} ${r.text}`);
    console.log("agent created:", a.name);
  }
}

async function waitCallable() {
  for (let i = 0; i < 12; i++) {
    const cat = await fetchCatalog({ token });
    if (cat.ok && ROLES.every((r) => cat.ids.has(agentModelId(cfg, r)))) return cat;
    console.log("waiting for agents to become callable...");
    await sleep(10000);
  }
  throw new Error("agents did not become callable in 2 minutes");
}

await ensureAgents();
if (dry) process.exit(0);
if (updated) { console.log("waiting 40s for the updated agents to take effect..."); await sleep(40000); }
const cat = await waitCallable();
const callChat = makeCallChat({ token });
const before = await fetchBalance({ token });
console.log("balance before:", before);
if (before == null) console.warn("WARNING: balance unreadable, the spend cap is NOT enforced");

for (const floor of floors) {
  const out = path.join(root, "recorded", `${floor.id}.json`);
  if (existsSync(out) && !process.argv.includes("--force")) { console.log(floor.id, "already recorded, skipping"); continue; }
  const args = { cfg, floor, callChat, availableIds: cat.ids, rates: cat.rates };
  const run = await runSteps(args);
  console.log(floor.id, "steps:", run.steps.length, "failed:", run.failed);
  if (run.failed) throw new Error(`job failed on ${floor.id} at ${run.failed}: ${JSON.stringify(run.steps.at(-1)).slice(0, 300)}`);
  const rec = { floorId: floor.id, recordedAt: new Date().toISOString(), steps: run.steps, outputs: run.outputs };
  if (floor.id === "kimchi") {
    const note = "Under 110 words, and add one sentence telling readers to throw a jar out if it smells rotten rather than sour.";
    const d = decide("revise", note);
    const again = await runSteps({ ...args, roles: d.rerun, prior: run.outputs, ownerNote: d.ownerNote });
    if (again.failed) throw new Error(`revision failed at ${again.failed}: ${JSON.stringify(again.steps.at(-1)).slice(0, 600)}`);
    rec.revision = { note, steps: again.steps, outputs: again.outputs };
  }
  writeFileSync(path.join(root, "recorded", `${floor.id}.json`), JSON.stringify(rec, null, 2));
  const now = await fetchBalance({ token });
  if (before != null && now != null && before - now > CAP) throw new Error(`spend cap ${CAP} reached: ${(before - now).toFixed(6)}`);
}
await sleep(4000);
const after = await fetchBalance({ token });
console.log("balance after:", after, "delta:", before != null && after != null ? (before - after).toFixed(8) : "n/a");

/**
 * lib/job.js — one "job" on a floor: research -> write -> review, then the owner decides.
 *
 * Pure logic. The network is injected (`callChat`), so the tests drive it with a fake.
 */

export const ROLES = ["researcher", "writer", "reviewer"];

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function parseJson(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/```(?:json)?/gi, "").trim();
  // Chatter such as "use {braces}" can come before the object, so try each "{" in turn.
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    const end = matchingBrace(s, start);
    if (end < 0) continue;
    const v = tryParse(s.slice(start, end + 1));
    if (v) return v;
  }
  return null;
}

function matchingBrace(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** A multi-paragraph body often arrives with real newlines inside the JSON string: escape them. */
function escapeControlChars(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const c of text) {
    if (inStr) {
      if (esc) { esc = false; out += c; continue; }
      if (c === "\\") { esc = true; out += c; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

/**
 * Small models sometimes emit a doubled closer ("],\n ],") or a trailing comma. Try the strict
 * parse first, then these two repairs; anything still invalid is reported as not-JSON.
 */
function tryParse(text) {
  const attempts = [
    text,
    text.replace(/,(\s*[}\]])/g, "$1"),
    text.replace(/([}\]])\s*,\s*[}\]](?=\s*,)/g, "$1").replace(/,(\s*[}\]])/g, "$1"),
    escapeControlChars(text),
    escapeControlChars(text).replace(/,(\s*[}\]])/g, "$1"),
  ];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      /* next repair */
    }
  }
  return null;
}

/** Callable id of one of our agents: community/<owner>/<name>. */
export function agentModelId(cfg, role) {
  return `community/${cfg.owner}/${cfg.agents[role].name}`;
}

/**
 * Decide what to call for a role. If the agent is in the visitor's catalogue we call it.
 * Otherwise we fall back to the base model with the same system prompt and say so.
 */
export function resolveRole(cfg, role, availableIds) {
  const id = agentModelId(cfg, role);
  if (availableIds && availableIds.has(id)) {
    return { model: id, standIn: false, inlineSystem: null };
  }
  return { model: cfg.baseModel, standIn: true, inlineSystem: cfg.agents[role].systemPrompt };
}

const clip = (v, n = 1200) => {
  if (typeof v === "string") return v.slice(0, n);
  const j = v === undefined ? "" : JSON.stringify(v);
  return (j || "").slice(0, n);
};

export function userMessage(role, floor, prior, ownerNote) {
  const head = `Company: ${floor.name}\nBrief: ${floor.brief}\nTask: ${floor.task}`;
  const note = ownerNote ? `\nOwner's revision note (follow it): ${clip(ownerNote, 400)}` : "";
  if (role === "researcher") return head + note;
  if (role === "writer") return `${head}${note}\n\nResearcher's notes:\n${clip(prior.researcher)}`;
  return `${head}\n\nResearcher's notes:\n${clip(prior.researcher)}\n\nWriter's deliverable:\n${clip(prior.writer)}`;
}

/** Estimated Pollen for one call from token counts and the live per-token rates. null if unknown. */
export function estimatePollen(usage, rate) {
  if (!usage || !rate) return null;
  const p = num(usage.prompt_tokens);
  const c = num(usage.completion_tokens);
  const rp = num(rate.promptTextTokens);
  const rc = num(rate.completionTextTokens);
  if (![p, c, rp, rc].every(Number.isFinite)) return null;
  return p * rp + c * rc;
}

/** A number, or NaN. Unlike Number(), null, "" and booleans do not become 0 or 1. */
function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

function addUsage(a, b) {
  if (!b) return a;
  if (!a) return { prompt_tokens: Number(b.prompt_tokens) || 0, completion_tokens: Number(b.completion_tokens) || 0 };
  return {
    prompt_tokens: a.prompt_tokens + (Number(b.prompt_tokens) || 0),
    completion_tokens: a.completion_tokens + (Number(b.completion_tokens) || 0),
  };
}

/**
 * Run the given roles in order. `callChat({model, messages})` -> {content, usage}.
 * `rates` maps model id -> {promptTextTokens, completionTextTokens}.
 * Returns { steps, outputs, failed } — it never throws for a bad reply, it records it.
 */
export async function runSteps({ cfg, floor, roles = ROLES, prior = {}, ownerNote = "", callChat, availableIds, rates = {}, onStep = null }) {
  const steps = [];
  const outputs = { ...prior };
  for (const role of roles) {
    const pick = resolveRole(cfg, role, availableIds);
    const messages = [];
    if (pick.inlineSystem) messages.push({ role: "system", content: pick.inlineSystem });
    messages.push({ role: "user", content: userMessage(role, floor, outputs, ownerNote) });
    let reply;
    let parsed = null;
    let attempts = 0;
    let usage = null;
    let estPollen = null;
    // A reply that is not JSON gets exactly one retry; both attempts are billed, so both are counted.
    while (attempts < 2 && !parsed) {
      attempts++;
      try {
        reply = await callChat({ model: pick.model, messages });
      } catch (e) {
        // A first attempt that was already billed must stay on the receipt.
        steps.push({ role, model: pick.model, standIn: pick.standIn, attempts, usage, estPollen, error: String((e && e.message) || e) });
        return { steps, outputs, failed: role };
      }
      parsed = parseJson(reply.content);
      const est = estimatePollen(reply.usage, rates[pick.model] || rates[cfg.baseModel]);
      estPollen = est === null ? estPollen : (estPollen || 0) + est;
      usage = addUsage(usage, reply.usage);
    }
    const step = {
      role,
      model: pick.model,
      standIn: pick.standIn,
      attempts,
      usage,
      estPollen,
      output: parsed,
      raw: parsed ? undefined : clip(reply.content, 600),
    };
    steps.push(step);
    if (onStep) onStep(step, steps);
    if (!parsed) return { steps, outputs, failed: role };
    outputs[role] = parsed;
  }
  return { steps, outputs, failed: null };
}

export function totalPollen(steps) {
  let known = 0;
  let unknown = 0;
  for (const s of steps) {
    if (typeof s.estPollen === "number") known += s.estPollen;
    else if (!s.error) unknown++;
  }
  return { known, unknown };
}

/** What the owner's decision does next. */
export function decide(action, note = "") {
  if (action === "approve") return { status: "approved", rerun: null };
  if (action === "hold") return { status: "held", rerun: null };
  if (action === "revise") {
    const n = String(note || "").trim();
    if (!n) return { status: "needs-note", rerun: null };
    return { status: "revising", rerun: ["writer", "reviewer"], ownerNote: n };
  }
  return { status: "invalid", rerun: null };
}

/**
 * lib/pollen.js — everything Receipts Tower sends to Pollinations.
 *
 * The visitor's key stays in this tab's sessionStorage and only travels in an
 * Authorization header, never in a URL. Every function takes `fetchImpl` for the tests.
 */

export const API_BASE = "https://gen.pollinations.ai";
export const ENTER_BASE = "https://enter.pollinations.ai";
const KEY_SLOT = "receipts-tower-key";

/** A number, or NaN. Unlike Number(), null, "" and booleans do not become 0 or 1. */
function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

export function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/* ------------------------------------------------------------------ key storage */

let memoryKey = ""; // used when the browser blocks sessionStorage

export function loadKey(storage) {
  try {
    const k = (storage || globalThis.sessionStorage).getItem(KEY_SLOT) || memoryKey;
    return k && k.startsWith("sk_") ? k : "";
  } catch {
    return memoryKey.startsWith("sk_") ? memoryKey : "";
  }
}

export function saveKey(key, storage) {
  memoryKey = key || "";
  try {
    const s = storage || globalThis.sessionStorage;
    if (key) s.setItem(KEY_SLOT, key);
    else s.removeItem(KEY_SLOT);
  } catch {
    /* storage blocked: the key lives in memory for this page only */
  }
}

/* ------------------------------------------------------------------ device flow */

export async function requestDeviceCode({ fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${ENTER_BASE}/api/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }
  if (!res.ok) return fail("PROVIDER_ERROR", `Could not start sign-in (HTTP ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    return fail("PROVIDER_ERROR", "Pollinations returned an unreadable sign-in response.");
  }
  if (!data || !data.device_code) return fail("PROVIDER_ERROR", "No device code in the response.");
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code || "",
    verificationUri: data.verification_uri || "",
    verificationUriComplete: data.verification_uri_complete || "",
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 1800,
  };
}

/** One poll: { ok:true, token } or { ok:false, pending:true, interval } or a failure. */
export async function pollDeviceToken({ fetchImpl = fetch, deviceCode, interval = 5 } = {}) {
  if (!deviceCode) return fail("AUTH_REQUIRED", "Start the sign-in flow first.");
  let res;
  try {
    res = await fetchImpl(`${ENTER_BASE}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // A blip or timeout does not invalidate the code: keep polling until it expires.
    return { ok: false, pending: true, interval };
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (data && typeof data.access_token === "string" && data.access_token.startsWith("sk_")) {
    return { ok: true, token: data.access_token };
  }
  const err = (data && data.error) || "";
  if (err === "slow_down") return { ok: false, pending: true, interval: Math.min(30, interval + 5) };
  if (err === "authorization_pending") return { ok: false, pending: true, interval };
  if (err === "expired_token" || err === "access_denied") {
    return fail("AUTH_REJECTED", "The sign-in request expired or was denied. Start again.");
  }
  if (res.status === 429 || res.status >= 500) return { ok: false, pending: true, interval };
  return fail("AUTH_REJECTED", "Could not complete sign-in. Start again.");
}

/* ------------------------------------------------------------------ catalogue + balance */

/** Callable model ids plus live per-token rates, read once per session. */
export async function fetchCatalog({ fetchImpl = fetch, token } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/v1/models`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("OFFLINE", "Could not read the model catalogue.");
  }
  if (!res.ok) return fail("PROVIDER_ERROR", `Model catalogue unavailable (HTTP ${res.status}).`);
  let body;
  try {
    body = await res.json();
  } catch {
    return fail("PROVIDER_ERROR", "Model catalogue was not JSON.");
  }
  const items = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];
  const ids = new Set();
  const rates = {};
  for (const m of items) {
    if (!m || typeof m.id !== "string") continue;
    ids.add(m.id);
    const p = m.pricing || {};
    const rp = num(p.promptTextTokens);
    const rc = num(p.completionTextTokens);
    if (Number.isFinite(rp) && Number.isFinite(rc)) rates[m.id] = { promptTextTokens: rp, completionTextTokens: rc };
  }
  return { ok: true, ids, rates };
}

/** Account balance (Pollen) or null when the key has no permission to read it. */
export async function fetchBalance({ fetchImpl = fetch, token } = {}) {
  if (!token) return null;
  try {
    const res = await fetchImpl(`${API_BASE}/account/balance`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    const n = Number(b && (b.balance ?? b.total));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ chat */

export function chatErrorMessage(status) {
  if (status === 401) return "Your key was rejected. Reconnect and try again.";
  if (status === 402) return "Out of Pollen for this key.";
  if (status === 403) return "This key is not allowed to call that model.";
  if (status === 404 || status === 400) return "That agent is not available to your key yet.";
  if (status === 429) return "Rate limited. Wait a few seconds and retry.";
  return `Pollinations returned HTTP ${status}.`;
}

export function makeCallChat({ fetchImpl = fetch, token, timeoutMs = 60000 }) {
  return async function callChat({ model, messages }) {
    if (!token) throw new Error("Connect your Pollen account first.");
    let res;
    try {
      res = await fetchImpl(`${API_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages, max_tokens: 900 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Offline or timed out. Check your connection and retry.");
    }
    if (!res.ok) throw new Error(chatErrorMessage(res.status));
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Pollinations returned an unreadable reply.");
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { content: typeof content === "string" ? content : "", usage: data && data.usage ? data.usage : null };
  };
}

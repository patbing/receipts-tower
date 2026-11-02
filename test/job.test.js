import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson, resolveRole, agentModelId, runSteps, estimatePollen, totalPollen, decide, userMessage } from "../lib/job.js";

const cfg = JSON.parse(readFileSync(new URL("../data/agents.json", import.meta.url), "utf8"));
const floor = JSON.parse(readFileSync(new URL("../data/floors.json", import.meta.url), "utf8")).floors[0];

test("parseJson: plain, fenced, chatter, nested braces in strings", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJson('Sure! {"t":"has } brace and \\" quote"} done'), { t: 'has } brace and " quote' });
  assert.equal(parseJson("no json here"), null);
  assert.equal(parseJson('{"a":'), null);
  assert.equal(parseJson(""), null);
  assert.equal(parseJson(undefined), null);
  assert.equal(parseJson("[1,2]"), null);
});

test("parseJson repairs a doubled closer and trailing commas but not real garbage", () => {
  const bad = '{\n "facts": ["a"],\n "assumptions": [\n "b"\n ],\n ],\n "risks": ["c"]\n}';
  assert.deepEqual(parseJson(bad), { facts: ["a"], assumptions: ["b"], risks: ["c"] });
  assert.deepEqual(parseJson('{"a":[1,2,],"b":{"c":1,},}'), { a: [1, 2], b: { c: 1 } });
  assert.equal(parseJson('{"a": [1, 2}'), null);
  assert.deepEqual(parseJson('{"s":"keep ], inside a string"}'), { s: "keep ], inside a string" });
});

test("resolveRole: uses the agent when callable, otherwise the base model with the prompt inline", () => {
  const id = agentModelId(cfg, "writer");
  assert.equal(id, "community/patbing/tower-writer");
  const live = resolveRole(cfg, "writer", new Set([id]));
  assert.equal(live.standIn, false);
  assert.equal(live.model, id);
  assert.equal(live.inlineSystem, null);
  const fallback = resolveRole(cfg, "writer", new Set());
  assert.equal(fallback.standIn, true);
  assert.equal(fallback.model, cfg.baseModel);
  assert.ok(fallback.inlineSystem.includes("Writer"));
  assert.equal(resolveRole(cfg, "writer", null).standIn, true);
});

test("estimatePollen needs usage and both rates", () => {
  const rate = { promptTextTokens: 0.000001, completionTextTokens: 0.000002 };
  assert.equal(estimatePollen({ prompt_tokens: 100, completion_tokens: 50 }, rate), 100 * 0.000001 + 50 * 0.000002);
  assert.equal(estimatePollen(null, rate), null);
  assert.equal(estimatePollen({ prompt_tokens: 1 }, rate), null);
  assert.equal(estimatePollen({ prompt_tokens: 1, completion_tokens: 1 }, undefined), null);
});

function fakeChat(replies) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

test("runSteps chains researcher -> writer -> reviewer and passes earlier output forward", async () => {
  const callChat = fakeChat([
    { content: '{"facts":["f1"]}', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { content: '{"title":"T","body":"B"}', usage: { prompt_tokens: 20, completion_tokens: 8 } },
    { content: '{"verdict":"ok","decisionQuestion":"Ship?","options":["yes","no"],"recommended":"yes"}', usage: { prompt_tokens: 30, completion_tokens: 9 } },
  ]);
  const rates = { [cfg.baseModel]: { promptTextTokens: 0.001, completionTextTokens: 0.002 } };
  const r = await runSteps({ cfg, floor, callChat, availableIds: new Set(), rates });
  assert.equal(r.failed, null);
  assert.equal(r.steps.length, 3);
  assert.ok(callChat.calls[1].messages.at(-1).content.includes('"f1"'));
  assert.ok(callChat.calls[2].messages.at(-1).content.includes('"title":"T"'));
  assert.equal(callChat.calls[0].messages[0].role, "system");
  const t = totalPollen(r.steps);
  assert.equal(t.unknown, 0);
  assert.ok(Math.abs(t.known - (10 * 0.001 + 5 * 0.002 + 20 * 0.001 + 8 * 0.002 + 30 * 0.001 + 9 * 0.002)) < 1e-12);
});

test("runSteps stops and records a thrown error or a non-JSON reply", async () => {
  let r = await runSteps({ cfg, floor, callChat: fakeChat([new Error("Out of Pollen for this key.")]), availableIds: new Set() });
  assert.equal(r.failed, "researcher");
  assert.equal(r.steps[0].error, "Out of Pollen for this key.");
  r = await runSteps({ cfg, floor, callChat: fakeChat([{ content: "I cannot do that.", usage: null }, { content: "Still no.", usage: null }]), availableIds: new Set() });
  assert.equal(r.failed, "researcher");
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].attempts, 2);
  assert.ok(r.steps[0].raw.includes("Still no"));
});

test("a non-JSON reply is retried once and both attempts are counted", async () => {
  const callChat = fakeChat([
    { content: "oops", usage: { prompt_tokens: 10, completion_tokens: 10 } },
    { content: '{"facts":["f"]}', usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ]);
  const rates = { [cfg.baseModel]: { promptTextTokens: 1, completionTextTokens: 1 } };
  const r = await runSteps({ cfg, floor, roles: ["researcher"], callChat, availableIds: new Set(), rates });
  assert.equal(r.failed, null);
  assert.equal(r.steps[0].attempts, 2);
  assert.deepEqual(r.steps[0].usage, { prompt_tokens: 20, completion_tokens: 30 });
  assert.equal(r.steps[0].estPollen, 50);
  assert.equal(callChat.calls.length, 2);
});

test("a revision reruns only writer and reviewer and carries the owner's note", async () => {
  const d = decide("revise", "  shorter please ");
  assert.deepEqual(d.rerun, ["writer", "reviewer"]);
  assert.equal(d.ownerNote, "shorter please");
  const callChat = fakeChat([{ content: '{"title":"T2","body":"B2"}' }, { content: '{"verdict":"ok"}' }]);
  const r = await runSteps({ cfg, floor, roles: d.rerun, prior: { researcher: { facts: ["f1"] } }, ownerNote: d.ownerNote, callChat, availableIds: new Set() });
  assert.equal(r.failed, null);
  assert.equal(callChat.calls.length, 2);
  assert.ok(callChat.calls[0].messages.at(-1).content.includes("shorter please"));
  assert.ok(r.outputs.researcher && r.outputs.writer && r.outputs.reviewer);
});

test("decide: approve, hold, revise needs a note, unknown action", () => {
  assert.equal(decide("approve").status, "approved");
  assert.equal(decide("hold").status, "held");
  assert.equal(decide("revise", "   ").status, "needs-note");
  assert.equal(decide("revise").rerun, null);
  assert.equal(decide("explode").status, "invalid");
});

test("userMessage clips very long prior output", () => {
  const big = { x: "y".repeat(5000) };
  const m = userMessage("writer", floor, { researcher: big }, "");
  assert.ok(m.length < 2200);
});

test("parseJson skips chatter braces before the real object", () => {
  assert.deepEqual(parseJson('use {braces} like so: {"a":1}'), { a: 1 });
});

test("null or empty rates and usage are unknown, not zero", () => {
  assert.equal(estimatePollen({ prompt_tokens: 5, completion_tokens: 5 }, { promptTextTokens: null, completionTextTokens: 1 }), null);
  assert.equal(estimatePollen({ prompt_tokens: 5, completion_tokens: 5 }, { promptTextTokens: "", completionTextTokens: 1 }), null);
  assert.equal(estimatePollen({ prompt_tokens: null, completion_tokens: 5 }, { promptTextTokens: 1, completionTextTokens: 1 }), null);
  assert.equal(estimatePollen({ prompt_tokens: 2, completion_tokens: 3 }, { promptTextTokens: "0.5", completionTextTokens: 1 }), 4);
});

test("a retry that throws keeps the billed first attempt on the receipt", async () => {
  const callChat = fakeChat([{ content: "nope", usage: { prompt_tokens: 100, completion_tokens: 50 } }, new Error("boom")]);
  const rates = { [cfg.baseModel]: { promptTextTokens: 1, completionTextTokens: 1 } };
  const r = await runSteps({ cfg, floor, roles: ["researcher"], callChat, availableIds: new Set(), rates });
  assert.equal(r.failed, "researcher");
  assert.equal(r.steps[0].error, "boom");
  assert.deepEqual(r.steps[0].usage, { prompt_tokens: 100, completion_tokens: 50 });
  assert.equal(totalPollen(r.steps).known, 150);
});

test("a writer rerun with no researcher notes does not throw", async () => {
  const callChat = fakeChat([{ content: '{"title":"t","body":"b"}' }]);
  const r = await runSteps({ cfg, floor, roles: ["writer"], prior: {}, callChat, availableIds: new Set() });
  assert.equal(r.failed, null);
});

test("parseJson accepts real newlines and tabs inside a string value", () => {
  const withRealNewlines = '{"title":"T","body":"line one\n\nline two\twith tab"}';
  assert.deepEqual(parseJson(withRealNewlines), { title: "T", body: "line one\n\nline two\twith tab" });
  assert.equal(parseJson('{"a":"x\ny", }').a, "x\ny");
  assert.equal(parseJson('{"a":"already \n escaped"}').a, "already \n escaped");
});

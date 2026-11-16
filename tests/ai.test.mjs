import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRules, evaluateRules, buildPrompt, historyExamples, callClaude, estimateCost, splitReply, diffLines } from "../web/lib/ai.js";

const ids = new Set(["groceries", "dining", "trip", "archive"]);
const tx = (id, date, amountCents, description, extra = {}) => ({ id, accountId: "a1", date, amountCents, description, ...extra });
const accounts = { a1: { last4: "1234" } };

test("parseRules: rules, reasons, quoted AND, ranges; bad lines reported, not fatal", () => {
  const { rules, errors } = parseRules([
    "```",
    "SET archive WHERE text \"ONLINE PAYMENT\" AND direction in  # card payment",
    "SET groceries WHERE text \"BED AND BATH\"",
    "- SET trip WHERE dates 2026-06-01..2026-06-20 AND text \"FOREIGN\" # Banff",
    "SET dining WHERE ids 3 5-7, 9",
    "SET pets WHERE ids 1",
    "SET dining WHERE price 5",
    "categorize everything",
    "```",
  ].join("\n"), ids);
  assert.equal(rules.length, 4);
  assert.deepEqual(rules[0].conds.map((c) => c.kind), ["text", "direction"]);
  assert.equal(rules[0].reason, "card payment");
  assert.equal(rules[1].conds[0].phrase, "bed and bath", "AND inside quotes is part of the phrase");
  assert.deepEqual([...rules[3].conds[0].ids], [3, 5, 6, 7, 9]);
  assert.deepEqual(errors.map((e) => e.error), ['unknown or not-allowed category "pets"', 'unknown condition "price"', "not a SET … WHERE … rule"]);
});

test("evaluateRules: only the sent transactions, last rule wins, unchanged ones aren't proposed", () => {
  const refs = [
    tx("1", "2026-06-02", -350, "FOREIGN TRANSACTION FEE"),
    tx("2", "2026-07-02", -350, "FOREIGN TRANSACTION FEE"),
    tx("3", "2026-06-05", 50000, "ONLINE PAYMENT THANK YOU"),
    tx("4", "2026-06-06", -2000, "TRADER JOES", { note: "bed and bath stuff" }),
    tx("5", "2026-06-07", -1500, "CAFE", { category: "dining" }),
  ];
  const { rules } = parseRules([
    'SET trip WHERE text "foreign" AND dates 2026-06-01..2026-06-20',
    'SET archive WHERE text "ONLINE PAYMENT" AND direction in AND account 1234',
    'SET groceries WHERE amount 10..25',
    'SET dining WHERE ids 4',           // later rule wins over the amount rule for ref 4
    'SET dining WHERE category dining', // no-op
  ].join("\n"), ids);
  const { proposals, counts } = evaluateRules(rules, refs, accounts);
  assert.deepEqual(proposals.map((p) => [p.t.id, p.from, p.to]), [["1", null, "trip"], ["3", null, "archive"], ["4", null, "dining"]]);
  assert.deepEqual(counts, [1, 1, 2, 1, 1]);
});

test("buildPrompt: compact lines, refs by date, only allowed categories (+ archive)", () => {
  const cats = { version: 2, groups: [{ id: "food", name: "Food", categories: [{ id: "groceries", name: "Groceries" }, { id: "dining", name: "Dining" }] }] };
  const { user, refs } = buildPrompt({
    txns: [tx("b", "2026-02-01", -1299, "NETFLIX|COM"), tx("a", "2026-01-01", 250000, "PAYROLL", { note: "jan\npay" })],
    categories: cats, allowed: new Set(["groceries", "archive"]), instructions: "be careful", examples: ["NETFLIX → dining ×3"], accounts,
  });
  assert.deepEqual(refs.map((t) => t.id), ["a", "b"]);
  assert.match(user, /^groceries = Food > Groceries$/m);
  assert.doesNotMatch(user, /dining = /);
  assert.match(user, /^archive = hide it/m);
  assert.match(user, /^1\|2026-01-01\|2500\.00\|1234\|PAYROLL\|jan pay\|-$/m);
  assert.match(user, /^2\|2026-02-01\|-12\.99\|1234\|NETFLIX COM\|\|-$/m, "separators and newlines can't break the format");
  assert.match(user, /NETFLIX → dining ×3/);
  assert.match(user, /My notes for this session:\nbe careful/);
});

test("historyExamples: merchant → most common category", () => {
  const ex = historyExamples([
    tx("1", "2026-01-01", -1, "SAFEWAY #1439 SANTA CLARA", { category: "groceries" }),
    tx("2", "2026-01-02", -1, "SAFEWAY #2201 SANTA CLARA", { category: "groceries" }),
    tx("3", "2026-01-03", -1, "SAFEWAY #1439 SANTA CLARA", { category: "dining" }),
    tx("4", "2026-01-03", -1, "SPLIT ONE", { category: "dining", splits: [{}] }),
  ]);
  assert.equal(ex.length, 1);
  assert.match(ex[0], /^SAFEWAY .* → groceries ×2 \(of 3\)$/);
});

test("callClaude: browser headers, streamed text and usage", async () => {
  let sent;
  const sse = [
    { type: "message_start", message: { usage: { input_tokens: 1200, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "SET dining " } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "WHERE ids 1" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const fetchImpl = async (url, opts) => { sent = { url, opts, body: JSON.parse(opts.body) }; return new Response(sse, { status: 200 }); };
  const progress = [];
  const r = await callClaude({ apiKey: "k", model: "claude-haiku-5-5", system: "S", user: "U", fetchImpl, onProgress: (p) => progress.push(p.chars) });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.opts.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(sent.opts.headers["x-api-key"], "k");
  assert.equal(sent.body.model, "claude-haiku-5-5");
  assert.equal(sent.body.stream, true);
  assert.equal(r.text, "SET dining WHERE ids 1", "thinking is not part of the reply");
  assert.deepEqual([r.usage.input_tokens, r.usage.output_tokens, r.stopReason], [1200, 40, "end_turn"]);
  assert.ok(progress.length > 0);

  const bad = async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
  await assert.rejects(callClaude({ apiKey: "x", model: "m", system: "", user: "", fetchImpl: bad }), /401 authentication_error: invalid x-api-key \(check the Anthropic API key/);
});

test("cost estimate uses Haiku's cheaper rate under 100K prompt tokens", () => {
  assert.equal(estimateCost("claude-haiku-5-5", 1_000_000, 0), 0.5, "above 100K the long-context rate applies");
  assert.equal(estimateCost("claude-haiku-5-5", 50_000, 10_000), 0.005 + 0.005);
});

test("splitReply / diffLines: rules and the optional NOTES block", () => {
  const r = splitReply("SET dining WHERE ids 1\n\nNOTES:\n- a\n- b\n");
  assert.equal(r.rules.trim(), "SET dining WHERE ids 1");
  assert.equal(r.notes, "- a\n- b");
  assert.equal(splitReply("SET dining WHERE ids 1").notes, null);
  assert.equal(splitReply("SET x WHERE ids 1\n**NOTES:**\n- c").notes, "- c");
  assert.deepEqual(diffLines("- a\n- b", "- a\n- c\n"), { added: ["- c"], removed: ["- b"] });
});

test("buildPrompt: one-time sessions tell the model not to write NOTES; normal ones invite it", () => {
  const cats = { version: 2, groups: [{ id: "food", name: "Food", categories: [{ id: "dining", name: "Dining" }] }] };
  const base = { txns: [tx("a", "2026-01-01", -100, "X")], categories: cats, allowed: new Set(["dining"]), aiNotes: "- old note" };
  const normal = buildPrompt({ ...base, instructions: "hi" });
  assert.match(normal.system, /end your reply with a line `NOTES:`/);
  assert.match(normal.user, /AI NOTES:\n- old note/);
  const once = buildPrompt({ ...base, instructions: "hi", oneTime: true });
  assert.match(once.system, /one-time only: do NOT write NOTES/);
  assert.match(once.user, /one-time only, don't remember them/);
});


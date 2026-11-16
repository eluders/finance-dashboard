// AI categorizer: Claude reads a compact list of transactions plus the user's instructions and answers
// in a tiny rule language. The page (not the model) evaluates the rules against the transactions that
// were sent, so the model can only ever propose CATEGORY changes, only for those transactions, and
// every proposal is reviewed before it's applied.
//
// Rule language (one rule per line; later rules win for the same transaction):
//   SET <category_id> WHERE <condition> [AND <condition>]...   # optional reason
// Conditions:
//   ids 3 7 12-15                 transaction refs from the list
//   text "phrase"                 description or note contains phrase (case-insensitive)
//   dates 2026-01-01..2026-01-31  inclusive
//   amount 12.99 | amount 10..20  absolute dollar amount, exact or inclusive range
//   direction out | direction in  money out of / into the account
//   account 1234                  account last 4
//   category <id> | category none current category ("none" = uncategorized)
import { ARCHIVE_ID } from "../../extension/src/lib/categories.js";

export const MODELS = {
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (cheapest)", inPerM: 0.10, outPerM: 0.50, inPerMLong: 0.50, outPerMLong: 2.50, longAbove: 100_000 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", inPerM: 2, outPerM: 10 },
  "claude-opus-5-5": { label: "Claude Opus 5.5 (most capable)", inPerM: 4, outPerM: 20 },
};
export const DEFAULT_MODEL = "claude-haiku-5-5";
const API_VERSION = "2026-10-21";

/** Rough token estimate for a prompt (≈3.5 characters per token; errs high). */
export const estimateTokens = (text) => Math.ceil(text.length / 3.2);

export function estimateCost(model, inputTokens, outputTokens = 0) {
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const long = m.longAbove && inputTokens > m.longAbove;
  return (inputTokens * (long ? m.inPerMLong : m.inPerM) + outputTokens * (long ? m.outPerMLong : m.outPerM)) / 1e6;
}

const money = (c) => (c < 0 ? "-" : "") + (Math.abs(c) / 100).toFixed(2);
const clean = (s) => String(s || "").replace(/[|\r\n]+/g, " ").trim();

/** First ~10 letters/digits of the description: groups the same merchant across transactions. */
export const merchantKey = (d) => String(d || "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\d{3,}/g, "").replace(/\s+/g, " ").trim().slice(0, 18);

/**
 * Builds the request. `txns` are the transactions in scope (already filtered; never split ones).
 * Returns { system, user, refs } where refs[i] is the transaction behind ref i+1.
 */
export function buildPrompt({ txns, categories, allowed, instructions, examples = [], accounts = {} }) {
  const refs = [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const catLines = categories.groups.flatMap((g) => g.categories.filter((c) => allowed.has(c.id)).map((c) => `${c.id} = ${g.name} > ${c.name}`));
  if (allowed.has(ARCHIVE_ID)) catLines.push(`${ARCHIVE_ID} = hide it (transfers, card payments, duplicates, anything that shouldn't count as spending)`);

  const system = [
    "You categorize personal bank and credit card transactions for one household.",
    "Reply ONLY with rules in this language, one per line, no other text:",
    "SET <category_id> WHERE <condition> [AND <condition>]...  # short reason",
    "Conditions: ids 3 7 12-15 | text \"phrase\" (in description or note, case-insensitive) | dates YYYY-MM-DD..YYYY-MM-DD | amount 12.99 | amount 10..20 (absolute dollars) | direction out|in | account 1234 | category <id>|none (current category)",
    "Rules apply only to the transactions listed. When several rules match a transaction, the LAST one wins, so put broad rules first and exceptions after.",
    "Prefer one precise `text` rule over listing many ids when the phrase identifies the merchant. Use `ids` for one-offs.",
    "Use only the category ids listed. If you aren't reasonably sure about a transaction, leave it out (it stays as it is).",
    "Follow the user's instructions exactly when they apply; they override your own judgment.",
    "Example:",
    "SET groceries WHERE text \"TRADER JOE\"  # grocery store",
    "SET archive WHERE text \"ONLINE PAYMENT\" AND direction in  # card payment",
    "SET dining WHERE ids 4 9  # restaurants",
  ].join("\n");

  const lines = refs.map((t, i) => [i + 1, t.date, money(t.amountCents), accounts[t.accountId]?.last4 || "", clean(t.description), clean(t.note), t.category || "-"].join("|"));
  const user = [
    `Categories:\n${catLines.join("\n")}`,
    examples.length ? `How I've categorized merchants before (merchant → category ×count):\n${examples.join("\n")}` : "",
    `Transactions (ref|date|amount, negative = money out|account|description|my note|current category):\n${lines.join("\n")}`,
    `My instructions:\n${instructions?.trim() || "(none) Categorize what you can confidently."}`,
  ].filter(Boolean).join("\n\n");
  return { system, user, refs };
}

/** "MERCHANT → category ×n" lines from already-categorized transactions, most common first. */
export function historyExamples(txns, limit = 250) {
  const by = new Map();
  for (const t of txns) {
    if (!t.category || t.splits?.length) continue;
    const k = merchantKey(t.description);
    if (!k) continue;
    const m = by.get(k) || new Map();
    m.set(t.category, (m.get(t.category) || 0) + 1);
    by.set(k, m);
  }
  return [...by.entries()]
    .map(([k, m]) => { const [cat, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; const total = [...m.values()].reduce((a, b) => a + b, 0); return { k, cat, n, total }; })
    .sort((a, b) => b.total - a.total).slice(0, limit)
    .map(({ k, cat, n, total }) => `${k} → ${cat} ×${n}${total > n ? ` (of ${total})` : ""}`);
}

// ---------- rule language ----------
/** Parses the model's reply. Returns { rules: [{ line, text, category, conds, reason }], errors: [{ line, text, error }] }. */
export function parseRules(reply, validIds) {
  const rules = [], errors = [];
  reply.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    let text = raw.trim().replace(/^[-*]\s+/, "").replace(/^`+|`+$/g, "");
    if (!text || text.startsWith("#") || /^```/.test(text)) return;
    let reason = "";
    const hash = findComment(text);
    if (hash >= 0) { reason = text.slice(hash + 1).trim(); text = text.slice(0, hash).trim(); }
    const m = /^SET\s+(\S+)\s+WHERE\s+(.+)$/i.exec(text);
    if (!m) { errors.push({ line, text: raw.trim(), error: "not a SET … WHERE … rule" }); return; }
    const category = m[1];
    if (!validIds.has(category)) { errors.push({ line, text: raw.trim(), error: `unknown or not-allowed category "${category}"` }); return; }
    try {
      const conds = splitAnd(m[2]).map(parseCond);
      rules.push({ line, text, category, conds, reason });
    } catch (e) { errors.push({ line, text: raw.trim(), error: e.message }); }
  });
  return { rules, errors };
}

/** Index of a "#" that starts a comment (not inside quotes), or -1. */
function findComment(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) { if (s[i] === '"') q = !q; else if (s[i] === "#" && !q) return i; }
  return -1;
}
function splitAnd(s) {
  const parts = []; let cur = "", q = false;
  const tokens = s.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const ch of t) if (ch === '"') q = !q;
    if (!q && /^AND$/i.test(t)) { parts.push(cur.trim()); cur = ""; } else cur += t;
  }
  parts.push(cur.trim());
  if (parts.some((p) => !p)) throw new Error("empty condition");
  return parts;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dollars = (s) => { const n = Number(s.replace(/[$,]/g, "")); if (!Number.isFinite(n) || n < 0) throw new Error(`bad amount "${s}"`); return Math.round(n * 100); };
function parseCond(c) {
  const m = /^(\w+)\s+(.+)$/.exec(c.trim());
  if (!m) throw new Error(`can't read condition "${c}"`);
  const [, kind, arg] = [m[0], m[1].toLowerCase(), m[2].trim()];
  switch (kind) {
    case "ids": {
      const set = new Set();
      for (const tok of arg.split(/[\s,]+/).filter(Boolean)) {
        const r = /^(\d+)(?:-(\d+))?$/.exec(tok);
        if (!r) throw new Error(`bad id "${tok}"`);
        const a = +r[1], b = r[2] ? +r[2] : a;
        if (b < a || b - a > 5000) throw new Error(`bad id range "${tok}"`);
        for (let k = a; k <= b; k++) set.add(k);
      }
      return { kind, ids: set };
    }
    case "text": {
      const q = /^"(.+)"$/.exec(arg);
      if (!q) throw new Error("text needs a quoted phrase");
      return { kind, phrase: q[1].toLowerCase() };
    }
    case "dates": {
      const [a, b] = arg.split("..").map((x) => x.trim());
      if (!DATE.test(a) || !DATE.test(b || a)) throw new Error(`bad dates "${arg}"`);
      return { kind, from: a, to: b || a };
    }
    case "amount": {
      const [a, b] = arg.split("..");
      return { kind, min: dollars(a), max: b == null ? dollars(a) : dollars(b) };
    }
    case "direction": {
      const d = arg.toLowerCase();
      if (d !== "in" && d !== "out") throw new Error("direction must be in or out");
      return { kind, d };
    }
    case "account": return { kind, last4: arg.replace(/\D/g, "") };
    case "category": return { kind, id: arg === "none" ? null : arg };
    default: throw new Error(`unknown condition "${kind}"`);
  }
}

function matches(cond, t, ref, last4) {
  switch (cond.kind) {
    case "ids": return cond.ids.has(ref);
    case "text": return `${t.description} ${t.note || ""}`.toLowerCase().includes(cond.phrase);
    case "dates": return t.date >= cond.from && t.date <= cond.to;
    case "amount": { const a = Math.abs(t.amountCents); return a >= cond.min && a <= cond.max; }
    case "direction": return cond.d === "out" ? t.amountCents < 0 : t.amountCents > 0;
    case "account": return last4 === cond.last4;
    case "category": return (t.category || null) === cond.id;
  }
  return false;
}

/**
 * Applies rules to the transactions that were sent (refs). Last matching rule wins.
 * Returns proposals for transactions whose category would actually change:
 *   [{ ref, t, from, to, rule }]  plus per-rule match counts.
 */
export function evaluateRules(rules, refs, accounts = {}) {
  const winner = new Map();
  const counts = rules.map(() => 0);
  refs.forEach((t, i) => {
    rules.forEach((r, ri) => {
      if (r.conds.every((c) => matches(c, t, i + 1, accounts[t.accountId]?.last4 || ""))) { winner.set(i, ri); counts[ri]++; }
    });
  });
  const proposals = [];
  for (const [i, ri] of winner) {
    const t = refs[i];
    const to = rules[ri].category;
    if ((t.category || null) !== to) proposals.push({ ref: i + 1, t, from: t.category || null, to, rule: ri });
  }
  proposals.sort((a, b) => a.rule - b.rule || (a.t.date < b.t.date ? -1 : 1));
  return { proposals, counts };
}

// ---------- API ----------
/**
 * Streams a Messages API request straight from the browser.
 * onProgress({ chars, outputTokens }) is called as text arrives. Returns { text, usage, stopReason }.
 */
export async function callClaude({ apiKey, model, system, user, maxTokens = 32000, onProgress, signal, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = `${res.status} ${j.error?.type || ""}: ${j.error?.message || ""}`.trim(); } catch (_) { /* not JSON */ }
    if (res.status === 401) msg += " (check the Anthropic API key in Settings)";
    throw new Error(`Claude API error ${msg}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.type === "message_start") Object.assign(usage, ev.message?.usage || {});
      else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text;
      else if (ev.type === "message_delta") { if (ev.usage) Object.assign(usage, ev.usage); stopReason = ev.delta?.stop_reason || stopReason; }
      else if (ev.type === "error") throw new Error(`Claude API error: ${ev.error?.message || "stream error"}`);
      onProgress?.({ chars: text.length, outputTokens: usage.output_tokens });
    }
  }
  return { text, usage, stopReason };
}

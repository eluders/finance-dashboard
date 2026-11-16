// "AI categorize" tab: pick what to send, ask Claude, review its proposed category changes as
// before → after, and apply the ones you keep. Only categories ever change (note, splits and counted
// amount are untouched; split transactions are never sent). Runs are logged in this browser.
import { el, fmtMoney, fmtDate } from "../extension/src/lib/ui.js";
import { ARCHIVE_ID } from "../extension/src/lib/categories.js";
import { storage } from "../extension/src/lib/platform.js";
import { buildPrompt, historyExamples, parseRules, evaluateRules, estimateTokens, estimateCost, MODELS, DEFAULT_MODEL } from "./lib/ai.js";

const UNCAT = "__uncat";
const DRAFT_KEY = "aiDraft";
let ctx = null;
let form = null;   // { from, to, account, send: Set, allow: Set, useHistory, instructions }
let model = DEFAULT_MODEL;
let running = null; // { id, abort, chars }

const $ = (id) => document.getElementById(id);
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const catName = (id) => (id == null ? "Uncategorized" : ctx.catIdx.get(id)?.name || `(deleted: ${id})`);
const keyOf = (t) => `${t.accountId}/${t.id}`;

export async function renderAiTab(c) {
  ctx = c;
  if (!ctx.loaded) { $("aiForm").textContent = "Loading…"; return; } // categories are needed for the pickers
  if (!form) {
    const saved = (await storage().get(DRAFT_KEY))[DRAFT_KEY] || {};
    const allIds = [...ctx.cats.groups.flatMap((g) => g.categories.map((x) => x.id)), ARCHIVE_ID];
    form = {
      from: saved.from || isoDaysAgo(90), to: saved.to || new Date().toISOString().slice(0, 10), account: saved.account || "",
      send: new Set(saved.send || [UNCAT]), allow: new Set(saved.allow || allIds), // allow: null = every category, incl. ones added later
      useHistory: saved.useHistory ?? true, instructions: saved.instructions || "",
    };
  }
  model = (await ctx.call("getConnection")).aiModel || DEFAULT_MODEL;
  drawForm();
  await drawLog();
}

function saveDraft() {
  const everything = form.allow.size === allIds(false).length;
  storage().set({ [DRAFT_KEY]: { ...form, send: [...form.send], allow: everything ? null : [...form.allow] } });
}

// ---------- scope ----------
function inScope() {
  const all = ctx.txns.filter((t) => t.date >= form.from && t.date <= form.to && (!form.account || t.accountId === form.account)
    && form.send.has(t.category && ctx.catIdx.has(t.category) ? t.category : UNCAT));
  return { txns: all.filter((t) => !t.splits?.length), skippedSplits: all.filter((t) => t.splits?.length).length };
}

function prompt() {
  const { txns, skippedSplits } = inScope();
  const accounts = Object.fromEntries(ctx.accounts.map((a) => [a.id, a]));
  const examples = form.useHistory ? historyExamples(ctx.txns.filter((t) => t.category && t.category !== ARCHIVE_ID && form.allow.has(t.category))) : [];
  return { ...buildPrompt({ txns, categories: ctx.cats, allowed: form.allow, instructions: form.instructions, examples, accounts }), skippedSplits, accounts };
}

// ---------- form ----------
/** Checkbox list of categories by group, collapsed into a <details>. */
function catPicker(title, set, { uncat = false } = {}) {
  const box = el("details", { class: "cat-picker" });
  const summary = el("summary");
  const label = () => { summary.textContent = `${title}: ${describe(set, uncat)}`; };
  const onChange = () => { label(); saveDraft(); updateEstimate(); };
  const check = (id, text) => {
    const cb = el("input", { type: "checkbox", checked: set.has(id) });
    cb.onchange = () => { if (cb.checked) set.add(id); else set.delete(id); syncGroups(); onChange(); };
    cb.dataset.id = id;
    return el("label", { class: "cb" }, cb, text);
  };
  const groupBoxes = [];
  const syncGroups = () => { for (const { cb, ids } of groupBoxes) { const n = ids.filter((i) => set.has(i)).length; cb.checked = n === ids.length; cb.indeterminate = n > 0 && n < ids.length; } };
  const body = el("div", { class: "cat-picker-body" },
    el("div", { class: "row" },
      Object.assign(el("button", { class: "icon" }, "All"), { onclick: () => { allIds(uncat).forEach((i) => set.add(i)); box.querySelectorAll("input[data-id]").forEach((x) => { x.checked = true; }); syncGroups(); onChange(); } }),
      Object.assign(el("button", { class: "icon" }, "None"), { onclick: () => { set.clear(); box.querySelectorAll("input[data-id]").forEach((x) => { x.checked = false; }); syncGroups(); onChange(); } })),
    el("div", { class: "cat-picker-special" }, uncat ? check(UNCAT, "Uncategorized") : null, check(ARCHIVE_ID, "Archive")),
    el("div", { class: "cat-picker-groups" }, ctx.cats.groups.map((g) => {
      const ids = g.categories.map((c) => c.id);
      const gcb = el("input", { type: "checkbox" });
      gcb.onchange = () => { for (const i of ids) { if (gcb.checked) set.add(i); else set.delete(i); } box.querySelectorAll("input[data-id]").forEach((x) => { if (ids.includes(x.dataset.id)) x.checked = gcb.checked; }); syncGroups(); onChange(); };
      groupBoxes.push({ cb: gcb, ids });
      return el("div", { class: "cat-picker-group" }, el("label", { class: "cb group" }, gcb, g.name), el("div", {}, g.categories.map((c) => check(c.id, c.name))));
    })));
  box.append(summary, body);
  label(); syncGroups();
  return box;
}
const allIds = (uncat) => [...(uncat ? [UNCAT] : []), ARCHIVE_ID, ...ctx.cats.groups.flatMap((g) => g.categories.map((c) => c.id))];
function describe(set, uncat) {
  const total = allIds(uncat).length;
  if (set.size === total) return "everything";
  if (!set.size) return "nothing";
  const names = [...set].slice(0, 3).map((i) => (i === UNCAT ? "Uncategorized" : catName(i)));
  return names.join(", ") + (set.size > 3 ? ` +${set.size - 3} more` : "");
}

function drawForm() {
  const box = $("aiForm");
  box.innerHTML = "";
  const from = el("input", { type: "date", value: form.from });
  const to = el("input", { type: "date", value: form.to });
  const acct = el("select", {}, el("option", { value: "" }, "All accounts"), ctx.accounts.map((a) => el("option", { value: a.id }, `${a.name} …${a.last4 || "?"}`)));
  acct.value = form.account;
  for (const [input, k] of [[from, "from"], [to, "to"], [acct, "account"]]) input.onchange = () => { form[k] = input.value; saveDraft(); updateEstimate(); };
  const instr = el("textarea", { rows: 5, placeholder: "Explain anything the AI should know, e.g.\n• All foreign transaction fees between 06-01 and 06-20 are the Banff trip.\n• Archive every ONLINE PAYMENT THANK YOU.\n• Costco gas is Gas, everything else at Costco is Groceries." });
  instr.value = form.instructions;
  instr.oninput = () => { form.instructions = instr.value; saveDraft(); updateEstimate(); };
  const hist = el("input", { type: "checkbox", checked: form.useHistory });
  hist.onchange = () => { form.useHistory = hist.checked; saveDraft(); updateEstimate(); };
  const run = el("button", { class: "primary", id: "aiRun" }, "Ask AI");
  run.onclick = runAi;
  const cancel = el("button", { id: "aiCancel", hidden: !running }, "Stop");
  cancel.onclick = () => running?.abort.abort();

  box.append(
    el("div", { class: "row", style: "justify-content:space-between" }, el("h2", { style: "margin:0" }, "AI categorize"), el("span", { class: "muted" }, `Model: ${MODELS[model]?.label || model} (change in Settings)`)),
    el("div", { class: "muted", style: "margin:2px 0 10px" }, "The AI only suggests categories. Nothing changes until you review its suggestions below and apply them. Split transactions aren't sent."),
    el("div", { class: "ai-grid" },
      el("div", {}, el("label", {}, "From"), from),
      el("div", {}, el("label", {}, "To"), to),
      el("div", {}, el("label", {}, "Account"), acct)),
    el("div", { class: "ai-pickers" },
      catPicker("Send transactions currently in", form.send, { uncat: true }),
      catPicker("AI may assign", form.allow)),
    el("label", {}, "Instructions"), instr,
    el("label", { class: "cb", style: "margin-top:8px" }, hist, "Include how I've categorized merchants before (helps a lot; costs a few tokens)"),
    el("div", { class: "row", style: "margin-top:10px" }, run, cancel, el("span", { id: "aiEstimate", class: "muted" })),
  );
  updateEstimate();
}

function updateEstimate() {
  const out = $("aiEstimate");
  if (!out) return;
  const p = prompt();
  const tokens = estimateTokens(p.system + p.user);
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const long = m.longAbove && tokens > m.longAbove;
  out.className = long ? "warn" : "muted";
  out.textContent = `${p.refs.length} transaction${p.refs.length === 1 ? "" : "s"}${p.skippedSplits ? ` (+${p.skippedSplits} split, not sent)` : ""} · ≈${tokens.toLocaleString()} tokens in · ≈$${estimateCost(model, tokens, 3000).toFixed(tokens > 20000 ? 2 : 3)}`
    + (long ? ` · over ${m.longAbove.toLocaleString()} tokens costs ${m.inPerMLong / m.inPerM}× more: narrow the dates` : "");
  $("aiRun").disabled = !!running || !p.refs.length || !form.allow.size;
}

// ---------- run ----------
async function runAi() {
  const p = prompt();
  if (!p.refs.length) return;
  const run = {
    id: crypto.randomUUID(), at: new Date().toISOString(), status: "running", model,
    scope: { from: form.from, to: form.to, account: form.account, send: [...form.send], allow: [...form.allow], useHistory: form.useHistory },
    instructions: form.instructions.trim(), txCount: p.refs.length,
  };
  running = { id: run.id, abort: new AbortController(), chars: 0 };
  $("aiCancel").hidden = false;
  updateEstimate();
  await ctx.call("saveAiRun", { run });
  await drawLog();
  try {
    const r = await ctx.call("aiRequest", {
      system: p.system, user: p.user, signal: running.abort.signal,
      onProgress: ({ chars, outputTokens }) => { const s = $(`progress-${run.id}`); if (s) s.textContent = `Receiving… ${outputTokens || 0} tokens, ${chars} characters of rules`; },
    });
    const allowed = new Set(form.allow);
    const parsed = parseRules(r.text, allowed);
    const { proposals, counts } = evaluateRules(parsed.rules, p.refs, p.accounts);
    Object.assign(run, {
      status: proposals.length ? "review" : "done", model: r.model, reply: r.text, stopReason: r.stopReason, usage: r.usage,
      cost: estimateCost(r.model, r.usage.input_tokens || 0, r.usage.output_tokens || 0),
      rules: parsed.rules.map((x, i) => ({ text: x.text, category: x.category, reason: x.reason, matched: counts[i] })),
      errors: parsed.errors,
      proposals: proposals.map((x) => ({ key: keyOf(x.t), date: x.t.date, description: x.t.description, note: x.t.note || "", amountCents: x.t.amountCents, from: x.from, to: x.to, rule: x.rule, selected: true })),
    });
    if (r.stopReason === "max_tokens") run.errors.push({ line: 0, text: "", error: "The reply was cut off (too long). Narrow the date range and try again." });
    if (r.stopReason === "refusal") run.errors.push({ line: 0, text: "", error: "The model declined this request." });
  } catch (e) {
    Object.assign(run, { status: "failed", error: e.name === "AbortError" ? "Stopped." : e.message });
  }
  running = null;
  await ctx.call("saveAiRun", { run });
  drawForm();
  await drawLog();
}

// ---------- log + review ----------
async function drawLog() {
  const box = $("aiLog");
  const runs = await ctx.call("getAiRuns");
  box.innerHTML = "";
  if (!runs.length) { box.append(el("div", { class: "card muted" }, "AI runs and their suggestions will show up here.")); return; }
  for (const run of runs) box.append(runCard(run));
}

function runCard(run) {
  const statusText = { running: running?.id === run.id ? "running" : "interrupted", review: "needs review", applied: "applied", discarded: "discarded", done: "no changes", failed: "failed" }[run.status];
  const meta = [
    new Date(run.at).toLocaleString(), MODELS[run.model]?.label.replace(/ \(.*/, "") || run.model,
    `${run.txCount} sent · ${fmtDate(run.scope.from)} – ${fmtDate(run.scope.to)}`,
    run.usage ? `${(run.usage.input_tokens || 0).toLocaleString()} in / ${(run.usage.output_tokens || 0).toLocaleString()} out tokens · $${run.cost.toFixed(4)}` : "",
  ].filter(Boolean).join(" · ");
  const del = el("button", { class: "icon", title: "Remove from log" }, "✕");
  del.onclick = async () => { await ctx.call("deleteAiRun", { id: run.id }); drawLog(); };

  const card = el("div", { class: `card ai-run ${run.status}` },
    el("div", { class: "row", style: "justify-content:space-between" },
      el("div", { class: "row" }, el("span", { class: `pill status-${run.status}` }, statusText), el("span", { class: "muted" }, meta)), del),
    run.instructions ? el("blockquote", { class: "ai-instructions" }, run.instructions) : null,
  );
  if (run.status === "running" && running?.id === run.id) card.append(el("div", { id: `progress-${run.id}`, class: "muted" }, "Waiting for the AI…"));
  if (run.error) card.append(el("div", { class: "bad" }, run.error));
  if (run.errors?.length) card.append(el("details", { class: "warn" }, el("summary", {}, `${run.errors.length} line${run.errors.length === 1 ? "" : "s"} of the reply couldn't be used`),
    el("ul", {}, run.errors.map((e) => el("li", {}, e.text ? el("code", {}, e.text) : "", e.text ? " → " : "", e.error)))));
  if (run.proposals) card.append(review(run));
  if (run.reply != null) card.append(el("details", {}, el("summary", { class: "muted" }, "AI reply (rules)"), el("pre", { class: "ai-reply" }, run.reply || "(empty)")));
  return card;
}

function review(run) {
  const wrap = el("div", { class: "ai-review" });
  if (!run.proposals.length) { wrap.append(el("div", { class: "muted" }, run.rules?.length ? "The rules matched nothing that would change." : "No suggestions.")); return wrap; }
  const editable = run.status === "review";
  const byRule = new Map();
  for (const p of run.proposals) { if (!byRule.has(p.rule)) byRule.set(p.rule, []); byRule.get(p.rule).push(p); }
  const applyBtn = el("button", { class: "primary" });
  const count = () => run.proposals.filter((p) => p.selected).length;
  const label = () => { applyBtn.textContent = `Apply ${count()} change${count() === 1 ? "" : "s"}`; applyBtn.disabled = !count(); };
  const persist = () => ctx.call("saveAiRun", { run });

  for (const [ri, list] of byRule) {
    const rule = run.rules[ri];
    const all = el("input", { type: "checkbox", checked: list.every((p) => p.selected), disabled: !editable, title: "Select all in this rule" });
    const boxes = [];
    all.onchange = () => { list.forEach((p, i) => { p.selected = all.checked; boxes[i].checked = all.checked; }); label(); persist(); };
    const rows = list.map((p, i) => {
      const cb = el("input", { type: "checkbox", checked: p.selected, disabled: !editable });
      boxes.push(cb);
      cb.onchange = () => { p.selected = cb.checked; all.checked = list.every((x) => x.selected); label(); persist(); };
      return el("tr", { class: p.result && p.result !== "applied" ? "skipped" : "" },
        el("td", {}, cb), el("td", {}, fmtDate(p.date)),
        el("td", { class: "desc", title: `${p.description}${p.note ? ` · ${p.note}` : ""}` }, p.description, p.note ? el("span", { class: "muted" }, ` · ${p.note}`) : ""),
        el("td", { class: `num ${p.amountCents > 0 ? "good" : ""}` }, fmtMoney(p.amountCents)),
        el("td", { class: p.from == null ? "muted" : "" }, catName(p.from)), el("td", { class: "arrow" }, "→"),
        el("td", { class: p.to === ARCHIVE_ID ? "muted" : "after" }, catName(p.to)),
        el("td", { class: "muted" }, p.result && p.result !== "applied" ? p.result : ""));
    });
    wrap.append(el("div", { class: "ai-rule" },
      el("div", { class: "row ai-rule-head" }, all, el("code", {}, rule.text), rule.reason ? el("span", { class: "muted" }, `# ${rule.reason}`) : "",
        el("span", { class: "muted" }, `${list.length} change${list.length === 1 ? "" : "s"}${rule.matched > list.length ? ` (${rule.matched - list.length} already right)` : ""}`)),
      el("table", { class: "ai-table" }, el("tbody", {}, rows))));
  }

  if (editable) {
    label();
    applyBtn.onclick = async () => applyRun(run);
    const discard = el("button", {}, "Discard");
    discard.onclick = async () => { run.status = "discarded"; await persist(); drawLog(); };
    wrap.append(el("div", { class: "row", style: "margin-top:10px" }, applyBtn, discard));
  } else if (run.status === "applied") {
    wrap.append(el("div", { class: "good", style: "margin-top:6px" }, `Applied ${run.appliedCount} change${run.appliedCount === 1 ? "" : "s"}${run.skippedCount ? ` · ${run.skippedCount} skipped (changed since)` : ""}. They save to GitHub with your other edits.`));
  }
  return wrap;
}

/** Applies the selected proposals: category only, and only if the transaction still has the "before" category. */
async function applyRun(run) {
  const byKey = new Map(ctx.txns.map((t) => [keyOf(t), t]));
  let applied = 0, skipped = 0;
  for (const p of run.proposals) {
    if (!p.selected) continue;
    const t = byKey.get(p.key);
    if (!t) p.result = "no longer exists";
    else if ((t.category || null) !== p.from) p.result = `now ${catName(t.category || null)}`;
    else if (t.splits?.length) p.result = "was split since";
    else { ctx.setCategory(t, p.to); p.result = "applied"; applied++; continue; }
    skipped++;
  }
  Object.assign(run, { status: "applied", appliedCount: applied, skippedCount: skipped, appliedAt: new Date().toISOString() });
  await ctx.call("saveAiRun", { run });
  ctx.setStatus(`Applied ${applied} AI suggestion${applied === 1 ? "" : "s"}.`, "good");
  drawLog();
}

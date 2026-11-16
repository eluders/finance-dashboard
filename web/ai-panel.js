// AI categorize: a panel on the right of the Transactions tab, plus the Logs tab.
//
// One flow: the AI categorizes the transactions the table currently shows (its account / category /
// date / search filters decide the scope; split transactions are never sent), guided by the user's
// notes for this session, its own long-term AI notes, and the household's history.
// Unless the session is marked "one-time only", the AI may propose an update to its notes; the user
// approves that together with the category changes. The model only proposes CATEGORY changes, in a
// small rule language the page evaluates; while reviewing, the table shows just the affected rows
// with an "After" column.
import { el, fmtMoney, fmtDate } from "../extension/src/lib/ui.js";
import { ARCHIVE_ID } from "../extension/src/lib/categories.js";
import { storage } from "../extension/src/lib/platform.js";
import { buildPrompt, buildNotesPrompt, splitReply, diffLines, historyExamples, ambiguousMerchants, parseRules, evaluateRules, estimateTokens, estimateCost, MODELS, DEFAULT_MODEL } from "./lib/ai.js";
import { catPicker, pickerIds } from "./cat-picker.js";

const DRAFT_KEY = "aiDraft";
const LOG_PREVIEW = 5;
let ctx = null;
let form = null;      // { allow: Set|null (= all), onlyUncat, oneTime, useHistory, session }
let model = DEFAULT_MODEL;
let running = null;   // { id, abort }
let reviewing = null; // run being reviewed in the table
let aiNotes = null;   // saved AI notes (string), loaded lazily
let notesDraft = null; // edited-but-unsaved AI notes
const logExpanded = new Set();

const $ = (id) => document.getElementById(id);
const keyOf = (t) => `${t.accountId}/${t.id}`;
const catName = (id) => (id == null ? "Uncategorized" : ctx.catIdx.get(id)?.name || `(deleted: ${id})`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function initAi(c) { ctx = c; }
export const isPanelOpen = () => document.body.classList.contains("ai-open");
export function openPanel() { document.body.classList.add("ai-open"); renderAiPanel(); }
export function closePanel() { document.body.classList.remove("ai-open"); }

/** For the table: { run, byKey } while a run is being reviewed, else null. */
export function review() {
  if (!reviewing) return null;
  return { run: reviewing, byKey: new Map(reviewing.proposals.map((p) => [p.key, p])) };
}
export function toggleProposal(key, on) {
  const p = reviewing?.proposals.find((x) => x.key === key);
  if (!p) return;
  p.selected = on;
  ctx.call("saveAiRun", { run: reviewing });
  renderAiPanel();
}

async function loadForm() {
  if (form) return;
  const saved = (await storage().get(DRAFT_KEY))[DRAFT_KEY] || {};
  form = { allow: saved.allow ? new Set(saved.allow) : null, onlyUncat: saved.onlyUncat ?? true, oneTime: !!saved.oneTime, useHistory: saved.useHistory ?? true, session: saved.session || "" };
}
function saveDraft() { storage().set({ [DRAFT_KEY]: { ...form, allow: form.allow ? [...form.allow] : null } }); }
const allowSet = () => form.allow || new Set(pickerIds(ctx.cats, { uncat: false }));
const savedNotes = () => aiNotes || "";

/** The transactions that would be sent. */
function scope() {
  const shown = ctx.shownRows();
  let txns = shown.filter((t) => !t.splits?.length);
  const splits = shown.length - txns.length;
  let categorized = 0;
  if (form.onlyUncat) { const before = txns.length; txns = txns.filter((t) => !t.category || !ctx.catIdx.has(t.category)); categorized = before - txns.length; }
  return { txns, splits, categorized };
}

function prompt() {
  const { txns } = scope();
  const allowed = allowSet();
  const accounts = Object.fromEntries(ctx.accounts.map((a) => [a.id, a]));
  const examples = form.useHistory ? historyExamples(ctx.txns.filter((t) => t.category && t.category !== ARCHIVE_ID && allowed.has(t.category))) : [];
  return {
    ...buildPrompt({ txns, categories: ctx.cats, allowed, instructions: form.session, examples, accounts, aiNotes: savedNotes(), oneTime: form.oneTime }),
    accounts, allowed,
  };
}

// ---------- panel ----------
export async function renderAiPanel() {
  const box = $("aiPanel");
  if (!box || !isPanelOpen()) return;
  if (!ctx.loaded) { box.textContent = "Loading…"; return; }
  await loadForm();
  model = (await ctx.call("getConnection")).aiModel || DEFAULT_MODEL;
  if (aiNotes == null) {
    aiNotes = "";
    ctx.call("getNotes").then((n) => { aiNotes = n.ai || ""; if (!reviewing) renderAiPanel(); }).catch((e) => ctx.setStatus(`Couldn't load the AI notes: ${e.message}`, "bad"));
  }
  box.innerHTML = "";
  const close = el("button", { class: "icon", title: "Close" }, "✕");
  close.onclick = () => { closePanel(); ctx.onReviewChange(); };
  box.append(el("div", { class: "row ai-panel-head" }, el("h2", {}, "AI categorize"), el("span", { class: "muted small" }, MODELS[model]?.label.replace(/ \(.*/, "") || model), el("div", { class: "spacer" }), close));
  if (reviewing) { box.append(reviewPanel()); return; }

  const s = scope();
  box.append(
    el("div", { class: "ai-scope" }, el("b", {}, plural(s.txns.length, "transaction")), " from the table will be sent",
      s.splits ? el("span", { class: "muted" }, ` · ${s.splits} split skipped`) : "", s.categorized ? el("span", { class: "muted" }, ` · ${s.categorized} already categorized skipped`) : ""),
    el("div", { class: "muted small" }, "Use the table's filters (account, categories, dates, search) to choose which."));
  const only = el("input", { type: "checkbox", checked: form.onlyUncat });
  only.onchange = () => { form.onlyUncat = only.checked; saveDraft(); renderAiPanel(); };
  box.append(el("label", { class: "cb" }, only, "Only uncategorized ones"));

  box.append(catPicker({ label: "AI may assign", set: allowSet(), cats: ctx.cats, uncat: false, onChange: (set) => { form.allow = set.size === pickerIds(ctx.cats, { uncat: false }).length ? null : set; saveDraft(); updateEstimate(); } }));

  const session = el("textarea", { id: "aiSession", rows: 5, placeholder: "Notes for this session, e.g.\n• Foreign transaction fees Jun 1–20 are the Banff trip.\n• Archive every ONLINE PAYMENT THANK YOU.\n• Costco gas is Gas; everything else at Costco is Groceries." });
  session.value = form.session;
  session.oninput = () => { form.session = session.value; saveDraft(); updateEstimate(); };
  const oneTime = el("input", { type: "checkbox", checked: form.oneTime, id: "aiOneTime" });
  oneTime.onchange = () => { form.oneTime = oneTime.checked; saveDraft(); updateEstimate(); };
  const hist = el("input", { type: "checkbox", checked: form.useHistory });
  hist.onchange = () => { form.useHistory = hist.checked; saveDraft(); updateEstimate(); };
  box.append(
    el("label", { for: "aiSession" }, "Notes for this session"), session,
    el("label", { class: "cb", title: "The AI won't add anything from this session to its notes (e.g. \"archive everything before March\")" }, oneTime, "One-time only (don't remember this session)"),
    el("label", { class: "cb" }, hist, "Include how I've categorized merchants before"),
  );

  const run = el("button", { class: "primary", id: "aiRun" }, "Categorize");
  run.onclick = runAi;
  const stop = el("button", { id: "aiStop", hidden: !running }, "Stop");
  stop.onclick = () => running?.abort.abort();
  box.append(el("div", { class: "row", style: "margin-top:10px" }, run, stop), el("div", { id: "aiEstimate", class: "muted small" }), el("div", { id: "aiProgress", class: "muted small" }));
  box.append(notesEditor());
  updateEstimate();
}

/** The AI's notes: collapsed by default, editable. */
function notesEditor() {
  const d = el("details", { class: "notes-editor" });
  const ta = el("textarea", { rows: 12, placeholder: "Empty for now. The AI adds what it learns from your sessions (unless they're one-time only)." });
  ta.value = notesDraft ?? savedNotes();
  const state = el("span", { class: "warn small" });
  const label = () => { state.textContent = notesDraft != null && notesDraft !== savedNotes() ? "unsaved" : ""; };
  ta.oninput = () => { notesDraft = ta.value; label(); };
  const save = el("button", {}, "Save");
  save.onclick = async () => {
    save.disabled = true;
    try { aiNotes = (await ctx.call("saveNotes", { ai: ta.value })).ai; notesDraft = null; label(); ctx.setStatus("AI notes saved to your data repo.", "good"); updateEstimate(); }
    catch (e) { ctx.setStatus(e.message, "bad"); }
    save.disabled = false;
  };
  const revert = el("button", {}, "Revert");
  revert.onclick = () => { notesDraft = null; ta.value = savedNotes(); label(); };
  const rebuild = el("button", { title: "Ask the AI to rewrite its notes from your whole categorization history" }, "Rebuild from my history");
  rebuild.onclick = async () => {
    rebuild.disabled = true; rebuild.textContent = "Rebuilding…";
    try {
      const labeled = ctx.txns.filter((t) => t.category && !t.splits?.length);
      const p = buildNotesPrompt({ categories: ctx.cats, aiNotes: ta.value, examples: historyExamples(labeled, 400), ambiguous: ambiguousMerchants(labeled) });
      const r = await ctx.call("aiRequest", { system: p.system, user: p.user });
      notesDraft = r.text.trim(); ta.value = notesDraft; d.open = true; label();
      ctx.setStatus(`The AI rewrote its notes ($${estimateCost(r.model, r.usage.input_tokens || 0, r.usage.output_tokens || 0).toFixed(4)}). Check them, then Save.`, "good");
    } catch (e) { ctx.setStatus(e.message, "bad"); }
    rebuild.disabled = false; rebuild.textContent = "Rebuild from my history";
  };
  const lines = (savedNotes().match(/\S.*$/gm) || []).length;
  d.append(el("summary", {}, "AI notes ", el("span", { class: "muted small" }, lines ? `(${plural(lines, "line")})` : "(empty)"), " ", state),
    el("div", { class: "muted small" }, "What the AI remembers between sessions. It proposes updates after each session; you can also edit them here."),
    ta, el("div", { class: "row" }, save, revert, rebuild));
  if (notesDraft != null) d.open = true;
  label();
  return d;
}

function updateEstimate() {
  const out = $("aiEstimate");
  if (!out) return;
  const p = prompt();
  const tokens = estimateTokens(p.system + p.user);
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const long = m.longAbove && tokens > m.longAbove;
  out.className = `small ${long ? "warn" : "muted"}`;
  out.textContent = `≈${tokens.toLocaleString()} tokens in · ≈$${estimateCost(model, tokens, 3000).toFixed(tokens > 20000 ? 2 : 3)}${long ? ` · over ${m.longAbove.toLocaleString()} tokens costs ${m.inPerMLong / m.inPerM}× more: filter to fewer rows` : ""}`;
  $("aiRun").disabled = !!running || !p.refs.length || !p.allowed.size;
}

// ---------- run ----------
async function runAi() {
  const p = prompt();
  if (!p.refs.length) return;
  const notesBefore = savedNotes();
  const run = {
    id: crypto.randomUUID(), at: new Date().toISOString(), status: "running", model,
    scope: { label: ctx.filterLabel(), allow: [...p.allowed] }, instructions: form.session.trim(), oneTime: form.oneTime, txCount: p.refs.length,
  };
  running = { id: run.id, abort: new AbortController() };
  $("aiRun").disabled = true; $("aiStop").hidden = false;
  $("aiProgress").textContent = "Waiting for the AI…";
  await ctx.call("saveAiRun", { run });
  try {
    const r = await ctx.call("aiRequest", {
      system: p.system, user: p.user, signal: running.abort.signal,
      onProgress: ({ chars, outputTokens }) => { const s = $("aiProgress"); if (s) s.textContent = `Receiving… ${outputTokens || 0} tokens (${chars} characters)`; },
    });
    const parts = splitReply(r.text);
    const parsed = parseRules(parts.rules, p.allowed);
    const { proposals, counts } = evaluateRules(parsed.rules, p.refs, p.accounts);
    const notesAfter = !run.oneTime && parts.notes && parts.notes.trim() !== notesBefore.trim() ? parts.notes.trim() : null;
    Object.assign(run, {
      model: r.model, reply: r.text, stopReason: r.stopReason, usage: r.usage,
      cost: estimateCost(r.model, r.usage.input_tokens || 0, r.usage.output_tokens || 0),
      rules: parsed.rules.map((x, i) => ({ text: x.text, category: x.category, reason: x.reason, matched: counts[i] })),
      errors: parsed.errors,
      proposals: proposals.map((x) => ({ key: keyOf(x.t), date: x.t.date, description: x.t.description, note: x.t.note || "", amountCents: x.t.amountCents, from: x.from, to: x.to, rule: x.rule, selected: true })),
      notes: notesAfter ? { before: notesBefore, after: notesAfter, selected: true } : null,
    });
    run.status = run.proposals.length || run.notes ? "review" : "done";
    if (r.stopReason === "max_tokens") run.errors.push({ line: 0, text: "", error: "The reply was cut off (too long). Filter to fewer rows and try again." });
    if (r.stopReason === "refusal") run.errors.push({ line: 0, text: "", error: "The model declined this request." });
    form.session = ""; saveDraft(); // the session is done; its notes live on in the run log (and maybe the AI notes)
  } catch (e) {
    Object.assign(run, { status: "failed", error: e.name === "AbortError" ? "Stopped." : e.message });
  }
  running = null;
  await ctx.call("saveAiRun", { run });
  if (run.status === "review") startReview(run);
  else {
    ctx.setStatus(run.status === "failed" ? `AI run failed: ${run.error}` : "The AI didn't suggest any changes.", run.status === "failed" ? "bad" : "muted");
    renderAiPanel();
  }
}

// ---------- review (table shows the affected rows with an After column) ----------
export function startReview(run) {
  reviewing = run;
  if (location.hash !== "#transactions") location.hash = "#transactions";
  openPanel();
  ctx.onReviewChange();
}
function endReview() { reviewing = null; ctx.onReviewChange(); renderAiPanel(); }

const selectedCount = (run) => run.proposals.filter((p) => p.selected).length + (run.notes?.selected ? 1 : 0);
const applyLabel = (run) => {
  const n = run.proposals.filter((p) => p.selected).length;
  return `Apply ${plural(n, "change")}${run.notes?.selected ? " + notes" : ""}`;
};

function reviewPanel() {
  const run = reviewing;
  const wrap = el("div", { class: "ai-review-panel" });
  const apply = el("button", { class: "primary", disabled: !selectedCount(run) }, applyLabel(run));
  apply.onclick = async () => { apply.disabled = true; await applyRun(run); endReview(); };
  const discard = el("button", {}, "Discard");
  discard.onclick = async () => { run.status = "discarded"; await ctx.call("saveAiRun", { run }); endReview(); };
  const later = el("button", { title: "Keep it in Logs to review later" }, "Later");
  later.onclick = endReview;
  wrap.append(
    el("div", { class: "ai-review-head" }, el("b", {}, plural(run.proposals.length, "suggested change")), el("span", { class: "muted small" }, run.usage ? ` · $${run.cost.toFixed(4)}` : "")),
    el("div", { class: "row" }, apply, discard, later),
    run.proposals.length ? el("div", { class: "muted small", style: "margin:6px 0" }, "The table shows only these rows, with the AI's category in the After column. Untick any you don't want.") : "",
  );
  if (run.notes) wrap.append(notesChange(run, true));
  const byRule = groupByRule(run);
  wrap.append(el("div", { class: "ai-rules" }, [...byRule].map(([ri, list]) => {
    const rule = run.rules[ri];
    const cb = el("input", { type: "checkbox", checked: list.every((p) => p.selected) });
    cb.indeterminate = !cb.checked && list.some((p) => p.selected);
    cb.onchange = () => { list.forEach((p) => { p.selected = cb.checked; }); ctx.call("saveAiRun", { run }); ctx.onReviewChange(); renderAiPanel(); };
    return el("div", { class: "ai-rule-line" }, el("label", { class: "cb" }, cb, el("span", {}, `${list.length} → ${catName(rule.category)}`)),
      el("code", { title: rule.text }, rule.text), rule.reason ? el("div", { class: "muted small" }, rule.reason) : "");
  })));
  if (run.errors?.length) wrap.append(errorsBox(run));
  wrap.append(el("details", {}, el("summary", { class: "muted small" }, "AI reply"), el("pre", { class: "ai-reply" }, run.reply || "(empty)")));
  return wrap;
}

/** Proposed AI-notes update as +/- lines, with a checkbox while it's still undecided. */
function notesChange(run, editable) {
  const { added, removed } = diffLines(run.notes.before, run.notes.after);
  const cb = el("input", { type: "checkbox", checked: run.notes.selected, disabled: !editable || run.status !== "review" });
  cb.onchange = () => { run.notes.selected = cb.checked; ctx.call("saveAiRun", { run }); if (reviewing === run) renderAiPanel(); else renderLogs(); };
  return el("div", { class: "notes-change" },
    el("label", { class: "cb" }, cb, el("b", {}, "Update AI notes"), el("span", { class: "muted small" }, ` +${added.length} −${removed.length} lines`)),
    el("div", { class: "notes-diff" }, removed.map((l) => el("div", { class: "del" }, `− ${l}`)), added.map((l) => el("div", { class: "add" }, `+ ${l}`))),
    el("details", {}, el("summary", { class: "muted small" }, "Full new notes"), el("pre", { class: "ai-reply" }, run.notes.after)));
}

function groupByRule(run) {
  const m = new Map();
  for (const p of run.proposals) { if (!m.has(p.rule)) m.set(p.rule, []); m.get(p.rule).push(p); }
  return m;
}
const errorsBox = (run) => el("details", { class: "warn" }, el("summary", {}, `${plural(run.errors.length, "line")} of the reply couldn't be used`),
  el("ul", {}, run.errors.map((e) => el("li", {}, e.text ? el("code", {}, e.text) : "", e.text ? " → " : "", e.error))));

/** Applies the selected proposals (category only, and only if unchanged since the run) and the notes update. */
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
  let notesMsg = "";
  if (run.notes?.selected) {
    try {
      // merge-safe: only overwrite if the notes haven't been edited since this run read them
      const current = (await ctx.call("getNotes")).ai || "";
      if (current.trim() !== run.notes.before.trim()) { run.notes.result = "notes changed since; not updated"; notesMsg = " AI notes changed since this run, so they weren't updated."; }
      else { aiNotes = (await ctx.call("saveNotes", { ai: run.notes.after })).ai; notesDraft = null; run.notes.result = "saved"; notesMsg = " AI notes updated."; }
    } catch (e) { run.notes.result = `not saved: ${e.message}`; notesMsg = ` AI notes not saved: ${e.message}`; }
  }
  Object.assign(run, { status: "applied", appliedCount: applied, skippedCount: skipped, appliedAt: new Date().toISOString() });
  await ctx.call("saveAiRun", { run });
  ctx.setStatus(`Applied ${plural(applied, "AI suggestion")}${skipped ? ` (${skipped} skipped: changed since)` : ""}.${notesMsg}`, "good");
}

// ---------- Logs tab ----------
export async function renderLogs() {
  const box = $("logsList");
  const runs = await ctx.call("getAiRuns");
  box.innerHTML = "";
  if (!runs.length) { box.append(el("div", { class: "card muted" }, "AI categorize sessions show up here.")); return; }
  for (const run of runs) box.append(runCard(run));
}

function runCard(run) {
  const statusText = { running: running?.id === run.id ? "running" : "interrupted", review: "needs review", applied: "applied", discarded: "discarded", done: "no changes", failed: "failed" }[run.status];
  const meta = [
    new Date(run.at).toLocaleString(), MODELS[run.model]?.label.replace(/ \(.*/, "") || run.model,
    `${run.txCount} sent${run.scope?.label ? ` (${run.scope.label})` : ""}`, run.oneTime ? "one-time only" : "",
    run.usage ? `${(run.usage.input_tokens || 0).toLocaleString()} in / ${(run.usage.output_tokens || 0).toLocaleString()} out tokens · $${run.cost.toFixed(4)}` : "",
  ].filter(Boolean).join(" · ");
  const del = el("button", { class: "icon", title: "Remove from log" }, "✕");
  del.onclick = async () => { await ctx.call("deleteAiRun", { id: run.id }); renderLogs(); };
  const card = el("div", { class: `card ai-run ${run.status}` },
    el("div", { class: "row", style: "justify-content:space-between" },
      el("div", { class: "row" }, el("span", { class: `pill status-${run.status}` }, statusText), el("span", { class: "muted small" }, meta)), del),
    run.instructions ? el("blockquote", { class: "ai-instructions" }, run.instructions) : null);
  if (run.error) card.append(el("div", { class: "bad" }, run.error));

  // actions first, so long sessions don't need scrolling
  if (run.status === "review") {
    const apply = el("button", { class: "primary", disabled: !selectedCount(run) }, applyLabel(run));
    apply.onclick = async () => { apply.disabled = true; await applyRun(run); renderLogs(); };
    const inTable = el("button", {}, "Review in Transactions");
    inTable.onclick = () => startReview(run);
    const discard = el("button", {}, "Discard");
    discard.onclick = async () => { run.status = "discarded"; await ctx.call("saveAiRun", { run }); renderLogs(); };
    card.append(el("div", { class: "row", style: "margin:8px 0" }, apply, run.proposals.length ? inTable : null, discard));
  } else if (run.status === "applied") {
    card.append(el("div", { class: "good small", style: "margin:6px 0" }, `Applied ${plural(run.appliedCount, "change")}${run.skippedCount ? ` · ${run.skippedCount} skipped (changed since)` : ""}${run.notes?.result ? ` · AI notes ${run.notes.result}` : ""}.`));
  }
  if (run.notes) card.append(notesChange(run, run.status === "review"));

  if (run.proposals?.length) {
    const all = logExpanded.has(run.id);
    const shown = all ? run.proposals : run.proposals.slice(0, LOG_PREVIEW);
    card.append(el("table", { class: "ai-table" }, el("tbody", {}, shown.map((p) => el("tr", { class: p.result && p.result !== "applied" ? "skipped" : !p.selected ? "unselected" : "" },
      el("td", {}, fmtDate(p.date)),
      el("td", { class: "desc", title: `${p.description}${p.note ? ` · ${p.note}` : ""}` }, p.description, p.note ? el("span", { class: "muted" }, ` · ${p.note}`) : ""),
      el("td", { class: `num ${p.amountCents > 0 ? "good" : ""}` }, fmtMoney(p.amountCents)),
      el("td", { class: p.from == null ? "muted" : "" }, catName(p.from)), el("td", { class: "arrow" }, "→"),
      el("td", { class: p.to === ARCHIVE_ID ? "muted" : "after" }, catName(p.to)),
      el("td", { class: "muted small" }, p.result && p.result !== "applied" ? p.result : !p.selected ? "not selected" : ""))))));
    if (run.proposals.length > LOG_PREVIEW) {
      const more = el("button", { class: "link-btn" }, all ? "Show fewer" : `Show all ${run.proposals.length}`);
      more.onclick = () => { if (all) logExpanded.delete(run.id); else logExpanded.add(run.id); renderLogs(); };
      card.append(more);
    }
  } else if (run.status === "done") card.append(el("div", { class: "muted small" }, run.rules?.length ? "The rules matched nothing that would change." : "No suggestions."));
  if (run.errors?.length) card.append(errorsBox(run));
  if (run.reply != null) card.append(el("details", {}, el("summary", { class: "muted small" }, "AI reply"), el("pre", { class: "ai-reply" }, run.reply || "(empty)")));
  return card;
}

// Web dashboard (served by GitHub Pages). Reads/writes the private data repo directly with the
// token saved in Settings. The shared data code lives in ../extension/src/lib/.
// Tabs: #summary (spending per category per month + category editor), #transactions, #settings.
import { fmtMoney, fmtDate, el, accountBadge, accountColor } from "../extension/src/lib/ui.js";
import { resolveSplits, parseMoneyInput } from "../extension/src/lib/splits.js";
import { categoryIndex, uniqueId, validateCategories, ARCHIVE_ID } from "../extension/src/lib/categories.js";
import { applyState, editableState, trackedCents } from "../extension/src/lib/edits.js";
import { onStorageChanged } from "../extension/src/lib/platform.js";
import { OUTBOX_KEY, pendingCount } from "./lib/outbox.js";
import { call } from "./lib/backend.js";
import { MODELS } from "./lib/ai.js";
import { initCellSelect, isSelected, render as renderSelection } from "./cell-select.js";
import { initAi, renderAiPanel, renderLogs, isPanelOpen, openPanel, review, toggleProposal } from "./ai-panel.js";
import { catPicker, pickerIds, describeSelection, UNCAT } from "./cat-picker.js";

const $ = (id) => document.getElementById(id);
let accounts = [], txns = [], cats = { version: 2, groups: [] }, catIdx = new Map(), catOptionsHtml = "";
let loaded = false;
const expanded = new Set();
const rowEls = new Map(); // txn id -> <tr>
const byId = () => Object.fromEntries(accounts.map((a) => [a.id, a]));
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function setStatus(msg, cls = "") { $("status").className = `status ${cls}`; $("status").textContent = msg; }

// ---------- AI categorize (see ai-panel.js) ----------
initAi({
  get txns() { return txns; }, get cats() { return cats; }, get accounts() { return accounts; }, get catIdx() { return catIdx; },
  get loaded() { return loaded; },
  call, setStatus,
  /** Category-only edit that keeps note, splits and counted amount. */
  setCategory(t, category) { commitEdit(t, { category }); },
  shownRows: () => shownRows(),
  filterLabel: () => filterLabel(),
  onReviewChange: () => { if (tab === "transactions") renderTransactions(); else if (tab === "logs") renderLogs(); },
});

// ---------- multi-select + copy/paste of categories (see cell-select.js) ----------
let displayedRows = [];
initCellSelect({
  rows: () => displayedRows,
  isActive: () => tab === "transactions" && !review(),
  setCategory: (t, category) => { commitEdit(t, { category }); refreshRow(t); },
  catName: (id) => (id == null ? "Uncategorized" : catIdx.get(id)?.name || id),
  catOptionsHtml: () => catOptionsHtml,
});

// ---------- tabs ----------
const TABS = ["summary", "transactions", "logs", "settings"];
let tab = null;
let editingCategories = false;

function showTab(name) {
  if (!TABS.includes(name)) name = "summary";
  tab = name;
  document.body.dataset.tab = name; // the AI panel only shows on Transactions
  for (const t of TABS) $(`tab-${t}`).hidden = t !== name;
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("active", a.dataset.tab === name);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  renderTab();
}
function renderTab() {
  if (tab === "summary") renderSummary();
  else if (tab === "transactions") renderTransactions();
  else if (tab === "settings") renderSettings();
  else if (tab === "logs") renderLogs();
}
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

$("reload").onclick = load;
$("editCategories").onclick = () => { if (editingCategories) return; editingCategories = true; openCategoryEditor(); renderSummary(); };
$("sumYear").onchange = renderSummary;
$("sumAccount").onchange = renderSummary;
for (const id of ["filterAccount", "filterDate", "dateFrom", "dateTo"]) $(id).onchange = renderTransactions;
$("aiOpen").onclick = () => { openPanel(); renderTransactions(); };
$("search").oninput = renderTransactions;
showTab(location.hash.slice(1));
load();

// ---------- loading ----------
async function load() {
  setStatus("Loading from GitHub…", "muted");
  let st;
  try {
    st = await call("getStatus");
    [accounts, txns, cats] = st.initialized
      ? await Promise.all([call("listAccounts"), call("getAllTransactions"), call("getCategories")])
      : [[], [], st.configured ? await call("getCategories") : cats];
  } catch (e) {
    setStatus(`Couldn't load from GitHub: ${e.message}`, "bad");
    return;
  }
  // overlay edits that are buffered locally but not on GitHub yet
  outboxState = await call("getOutbox");
  const byKey = new Map(txns.map((t) => [`${t.accountId}/${t.id}`, t]));
  for (const [key, e] of Object.entries(outboxState.tx || {})) {
    const t = byKey.get(key);
    if (t) try { applyState(t, e.state, undefined, { lenient: true }); } catch (_) { /* flagged on flush */ }
  }
  if (outboxState.categories) cats = outboxState.categories.doc;
  renderSaveState();
  setCategories(cats);
  loaded = true;

  if (!st.configured) { setStatus("Not connected to your data repo yet. Fill in the connection below.", "warn"); showTab("settings"); }
  else if (!st.initialized) setStatus(`${st.repo} has no data yet. Save a page from the extension to set it up.`, "warn");
  else if (!st.importCount) setStatus("No imports yet. In the extension, on a bank page: Extract → Compare with saved → Save.", "warn");
  else setStatus("");

  fillAccountSelect($("filterAccount"));
  fillAccountSelect($("sumAccount"));
  const years = [...new Set(txns.map((t) => t.date.slice(0, 4)))].sort().reverse();
  const ys = $("sumYear");
  const keepYear = ys.value;
  ys.innerHTML = "";
  for (const y of years.length ? years : [String(new Date().getFullYear())]) ys.append(new Option(y, y));
  if ([...ys.options].some((o) => o.value === keepYear)) ys.value = keepYear;
  renderTab();
}

function fillAccountSelect(sel) {
  const keep = sel.value;
  sel.length = 1;
  for (const a of accounts) sel.append(el("option", { value: a.id }, `${a.name}  …${a.last4 || "?"}`));
  sel.value = accounts.some((a) => a.id === keep) ? keep : "";
}

function setCategories(doc) {
  cats = doc;
  catIdx = categoryIndex(doc);
  if ($("filterCategory")) buildCategoryFilter();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  catOptionsHtml = `<option value="">Uncategorized</option>` + doc.groups.map((g) =>
    `<optgroup label="${esc(g.name)}">${g.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</optgroup>`).join("")
    + `<optgroup label="Hidden"><option value="${ARCHIVE_ID}">Archive</option></optgroup>`;
}

function catSelect(value, cls = "cell-select") {
  const s = document.createElement("select");
  s.className = cls;
  s.innerHTML = catOptionsHtml;
  if (value && !catIdx.has(value)) s.append(new Option(`(deleted: ${value})`, value));
  s.value = value || "";
  s.classList.toggle("uncat", !s.value); // faint text = still to do
  s.classList.toggle("archived", s.value === ARCHIVE_ID);
  return s;
}

// ---------- editing: instant locally, buffered in the outbox, flushed to GitHub ----------
let outboxState = null; // last known outbox (kept fresh via storage change events)
const FLUSH_MS = 60_000; // must match lib/outbox.js default

/** Applies an edit to the in-memory transaction now and queues its final state for GitHub. */
function commitEdit(t, changes) {
  const next = { ...editableState(t), ...changes };
  applyState(structuredClone(t), next); // validate on a copy first: a rejected edit must not half-apply
  applyState(t, next);
  queueOp({ type: "tx", entry: { accountId: t.accountId, id: t.id, date: t.date, state: editableState(t) } });
}

function queueOp(op) {
  call("queueEdit", { op }).catch((e) => setStatus(`Couldn't buffer the edit locally: ${e.message}`, "bad"));
}

function saveNow() { return call("flushOutbox").catch((e) => setStatus(e.message, "bad")); }

const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function renderSaveState() {
  const o = outboxState;
  const n = pendingCount(o);
  const el_ = $("saveState");
  const btn = $("saveNow");
  btn.disabled = !n || o?.flushing;
  btn.className = n ? "primary" : "";
  if (o?.flushing) { el_.className = "muted"; el_.textContent = `Saving ${n} change${n === 1 ? "" : "s"}…`; }
  else if (n && o.lastFlush && !o.lastFlush.ok && o.lastFlush.at >= (o.since || 0)) {
    el_.className = "bad"; el_.textContent = `Save failed (${o.lastFlush.error}). Kept locally; retrying in ${mmss(o.lastFlush.at + FLUSH_MS - Date.now())}`;
  }
  else if (n) { el_.className = "warn"; el_.textContent = `${n} unsaved change${n === 1 ? "" : "s"} · auto-save in ${mmss((o.since || Date.now()) + FLUSH_MS - Date.now())}`; }
  else { el_.className = "good"; el_.textContent = o?.lastFlush ? "All changes saved ✓" : ""; }
  const failed = o?.failed || [];
  $("failedEdits").hidden = !failed.length;
  if (failed.length) $("failedText").textContent = `${failed.length} edit${failed.length === 1 ? "" : "s"} couldn't be saved: ${failed[failed.length - 1].error} `;
}

onStorageChanged((changes, area) => {
  if (area === "local" && changes[OUTBOX_KEY]) { outboxState = changes[OUTBOX_KEY].newValue; renderSaveState(); }
});
setInterval(renderSaveState, 1000);
$("saveNow").onclick = saveNow;
$("dismissFailed").onclick = () => call("clearFailedEdits");
window.addEventListener("beforeunload", (e) => {
  if (!pendingCount(outboxState)) return;
  saveNow();          // start saving right away; if the tab closes first, edits stay in this browser and save next visit
  e.preventDefault(); // and ask the browser to confirm leaving
  e.returnValue = "";
});

// ---------- summary tab ----------
/** Groups split into sections at each `sectionBreak` group (e.g. spending | investments | not counted). */
function sections(groups) {
  const out = [];
  for (const g of groups) { if (!out.length || g.sectionBreak) out.push([]); out.at(-1).push(g); }
  return out;
}

/** Net outflow in cents per category per month: Map(categoryId | UNCAT -> number[12]). Splits count per part. */
function monthlyTotals(year, accountId) {
  const sums = new Map();
  const months = new Set();
  const add = (cat, m, cents) => {
    const key = cat && catIdx.has(cat) ? cat : UNCAT;
    let a = sums.get(key);
    if (!a) sums.set(key, (a = Array(12).fill(0)));
    a[m] -= cents; // money out (negative) counts as positive spending
  };
  for (const t of txns) {
    if (!t.date.startsWith(year) || (accountId && t.accountId !== accountId)) continue;
    const m = +t.date.slice(5, 7) - 1;
    months.add(m);
    if (t.splits?.length) for (const s of t.splits) add(s.category, m, s.amountCents);
    else if (trackedCents(t)) add(t.category, m, trackedCents(t));
  }
  return { sums, months: [...months].sort((a, b) => a - b) };
}

const sumArr = (arrs) => arrs.reduce((acc, a) => (a ? acc.map((v, i) => v + a[i]) : acc), Array(12).fill(0));
/** Whole dollars; money that came in (negative spending) shows green. */
function moneyCell(cents, attrs = {}) {
  const td = el("td", { class: `num${cents < 0 ? " good" : ""}${attrs.class ? ` ${attrs.class}` : ""}` });
  if (cents) {
    td.textContent = "$" + Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
    td.title = `${cents < 0 ? "net money in " : ""}${fmtMoney(Math.abs(cents))}`;
  }
  if (attrs.onclick) { td.classList.add("link"); td.onclick = attrs.onclick; }
  return td;
}

function renderSummary() {
  $("editCategories").hidden = editingCategories;
  const body = $("summaryBody");
  if (editingCategories) { drawCategoryEditor(); return; }
  body.innerHTML = "";
  if (!loaded) return;
  const year = $("sumYear").value;
  const acct = $("sumAccount").value;
  const { sums, months } = monthlyTotals(year, acct);
  if (!months.length) { body.append(el("div", { class: "card muted" }, `No transactions in ${year}.`)); return; }
  const cols = [];
  for (let m = months[0]; m <= months.at(-1); m++) cols.push(m);
  const avgDiv = cols.length;
  const goto = (category, m) => () => openTransactions({ category, date: m == null ? year : `${year}-${String(m + 1).padStart(2, "0")}`, account: acct });

  const line = (label, arr, { cls = "", category = null, labelCls = "" } = {}) => {
    const total = arr.reduce((a, b) => a + b, 0);
    return el("tr", { class: cls },
      el("td", { class: `label ${labelCls}` }, category ? Object.assign(el("a", { href: "#transactions" }, label), { onclick: (e) => { e.preventDefault(); goto(category, null)(); } }) : label),
      cols.map((m) => moneyCell(arr[m], category ? { onclick: goto(category, m) } : {})),
      moneyCell(total, { class: "total" }),
      moneyCell(Math.round(total / avgDiv), { class: "avg" }));
  };

  const tbody = el("tbody");
  sections(cats.groups).forEach((sec, si) => {
    if (si > 0) tbody.append(el("tr", { class: "section-gap" }, el("td", { colspan: cols.length + 3 })));
    for (const g of sec) {
      const groupArr = sumArr(g.categories.map((c) => sums.get(c.id)));
      tbody.append(line(g.name, groupArr, { cls: "group-row", category: `g:${g.id}` }));
      for (const c of g.categories) tbody.append(line(c.name, sums.get(c.id) || Array(12).fill(0), { cls: "cat-line", category: c.id }));
    }
    const secArr = sumArr(sec.flatMap((g) => g.categories.map((c) => sums.get(c.id))));
    tbody.append(line("Subtotal", secArr, { cls: "subtotal-row" }));
  });
  if (sums.has(UNCAT)) {
    tbody.append(el("tr", { class: "section-gap" }, el("td", { colspan: cols.length + 3 })));
    tbody.append(line("Uncategorized", sums.get(UNCAT), { cls: "uncat-row", category: UNCAT }));
  }

  body.append(el("div", { class: "card table-card summary-card" }, el("table", { class: "summary" },
    el("thead", {}, el("tr", {}, el("th", { class: "label" }, "Category"), cols.map((m) => el("th", { class: "num" }, MONTHS[m])), el("th", { class: "num total" }, "Total"), el("th", { class: "num avg", title: `Average over ${avgDiv} month${avgDiv === 1 ? "" : "s"}` }, "Avg / mo"))),
    tbody)));
}

// ---------- transactions tab ----------
// Category filter: a Set of category ids + UNCAT + ARCHIVE_ID. Default = everything but Archive.
const allButArchive = () => new Set(pickerIds(cats).filter((i) => i !== ARCHIVE_ID));
let txCatSet = null;      // the live Set the picker edits
let txCatIsDefault = true; // still "everything but Archive" (so new categories join it)
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function buildCategoryFilter() {
  if (!txCatSet || txCatIsDefault) txCatSet = allButArchive();
  else for (const id of [...txCatSet]) if (id !== UNCAT && id !== ARCHIVE_ID && !catIdx.has(id)) txCatSet.delete(id); // deleted categories
  const box = $("filterCategoryBox");
  box.innerHTML = "";
  box.append(catPicker({ label: "Categories", set: txCatSet, cats, popover: true, id: "filterCategory", onChange: (set) => { txCatIsDefault = sameSet(set, allButArchive()); renderTransactions(); } }));
}

function setCategoryFilter(ids) {
  txCatSet = new Set(ids);
  txCatIsDefault = sameSet(txCatSet, allButArchive());
  buildCategoryFilter();
}

function openTransactions({ category = "", date = "", account = "" }) {
  $("filterAccount").value = account;
  fillDateFilter();
  if (!category) setCategoryFilter(allButArchive());
  else if (category.startsWith("g:")) setCategoryFilter(cats.groups.find((g) => g.id === category.slice(2))?.categories.map((c) => c.id) || []);
  else setCategoryFilter([category]);
  $("filterDate").value = date;
  $("dateRange").hidden = true;
  $("search").value = "";
  location.hash = "#transactions";
}

function fillDateFilter() {
  const sel = $("filterDate");
  const keep = sel.value;
  sel.innerHTML = "";
  sel.append(new Option("All dates", ""), new Option("Custom range…", "custom"));
  const months = [...new Set(txns.map((t) => t.date.slice(0, 7)))].sort().reverse();
  let year = null;
  for (const ym of months) {
    if (ym.slice(0, 4) !== year) { year = ym.slice(0, 4); sel.append(new Option(`All of ${year}`, year)); }
    sel.append(new Option(`${MONTHS[+ym.slice(5) - 1]} ${year}`, ym));
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  $("dateRange").hidden = sel.value !== "custom";
}

function inDates(t) {
  const v = $("filterDate").value;
  if (v !== "custom") return t.date.startsWith(v);
  const from = $("dateFrom").value, to = $("dateTo").value;
  return (!from || t.date >= from) && (!to || t.date <= to);
}

/** Does transaction t (or one of its split parts) match the category filter? Archived rows need Archive ticked. */
const isArchived = (t) => (t.splits?.length ? t.splits.every((s) => s.category === ARCHIVE_ID) : t.category === ARCHIVE_ID);
function inCategory(t, set) {
  if (isArchived(t)) return set.has(ARCHIVE_ID);
  const keys = (t.splits?.length ? t.splits.map((s) => s.category) : [t.category]).map((c) => (c && catIdx.has(c) ? c : UNCAT));
  return keys.some((k) => set.has(k));
}

/** The rows the filters select (also the AI's scope). */
function shownRows() {
  if (!loaded) return [];
  const acct = $("filterAccount").value;
  const q = $("search").value.toLowerCase();
  const set = txCatSet || allButArchive();
  return txns.filter((t) => (!acct || t.accountId === acct) && inDates(t) && inCategory(t, set)
    && (!q || t.description.toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q) || (t.merchant || "").toLowerCase().includes(q)));
}

/** Short description of the current filters (for the AI log). */
function filterLabel() {
  const parts = [];
  const a = accounts.find((x) => x.id === $("filterAccount").value);
  if (a) parts.push(`…${a.last4 || a.name}`);
  const d = $("filterDate");
  if (d.value === "custom") parts.push(`${$("dateFrom").value || "start"} – ${$("dateTo").value || "today"}`);
  else if (d.value) parts.push(d.selectedOptions[0]?.textContent || d.value);
  const cs = describeSelection(txCatSet || allButArchive(), cats);
  if (cs !== "all but Archive") parts.push(cs);
  if ($("search").value) parts.push(`"${$("search").value}"`);
  return parts.join(" · ") || "all";
}

function renderTransactions() {
  if (!loaded) return;
  fillDateFilter();
  if (!$("filterCategory")) buildCategoryFilter();
  const rv = review();
  document.body.classList.toggle("reviewing", !!rv);
  $("txToolbar").classList.toggle("disabled", !!rv);
  $("aiOpen").hidden = isPanelOpen();

  let rows;
  if (rv) {
    rows = txns.filter((t) => rv.byKey.has(`${t.accountId}/${t.id}`)).sort((a, b) => rv.byKey.get(`${a.accountId}/${a.id}`).rule - rv.byKey.get(`${b.accountId}/${b.id}`).rule || (a.date < b.date ? 1 : -1));
    const sel = rv.run.proposals.filter((p) => p.selected).length;
    $("reviewBanner").hidden = false;
    $("reviewBanner").textContent = `Reviewing AI suggestions: showing only the ${rows.length} rows it would change (${sel} selected). Apply or discard in the panel on the right.`;
    $("count").textContent = "";
  } else {
    $("reviewBanner").hidden = true;
    rows = shownRows();
    const net = rows.reduce((s, t) => s + trackedCents(t), 0);
    const hidden = (txCatSet || allButArchive()).has(ARCHIVE_ID) ? 0 : txns.filter((t) => isArchived(t) && (!$("filterAccount").value || t.accountId === $("filterAccount").value) && inDates(t)).length;
    $("count").textContent = `${rows.length} transaction${rows.length === 1 ? "" : "s"} · net ${fmtMoney(net)}${hidden ? ` · ${hidden} archived hidden` : ""}`;
  }

  const accts = byId();
  displayedRows = rows.slice(0, 2000);
  rowEls.clear();
  const body = el("tbody");
  for (const t of rows.slice(0, 2000)) {
    const tr = rowFor(t, accts);
    rowEls.set(t.id, tr);
    body.append(tr);
    if (expanded.has(t.id)) body.append(detailRow(t));
  }
  const narrow = isPanelOpen();
  $("txns").innerHTML = "";
  $("txns").append(el("div", { class: "card table-card" }, el("table", { class: "dense" },
    el("colgroup", {},
      el("col", { style: `width:${narrow ? 64 : 74}px` }),  // account badge
      el("col", { style: `width:${narrow ? 88 : 96}px` }),  // MM-DD-YYYY
      el("col", { style: `width:${narrow ? 22 : 25}%` }),   // bank description
      el("col", { style: `width:${narrow ? 92 : 105}px` }), // amount
      el("col"),                                            // your note
      el("col", { style: `width:${narrow ? 170 : 220}px` }), // category
      rv ? el("col", { style: "width:180px" }) : null),     // AI's proposal
    el("thead", {}, el("tr", {}, el("th", {}, "Account"), el("th", {}, "Date"), el("th", {}, "Description"), el("th", { class: "num" }, "Amount"), el("th", {}, "Note"),
      el("th", {}, rv ? "Before" : "Category"), rv ? el("th", { class: "after-col" }, "After (AI)") : null)),
    body,
  )));
  renderSelection();
  if (isPanelOpen() && !rv) renderAiPanel();
}

function rowFor(t, accts = byId()) {
  const note = el("input", { class: "cell-input", value: t.note || "", placeholder: "" });
  note.onkeydown = (e) => {
    if (e.key === "Enter") note.blur();
    if (e.key === "Escape") { note.value = t.note || ""; note.blur(); }
  };
  note.onchange = () => { if ((note.value.trim() || undefined) !== t.note) commitEdit(t, { note: note.value }); };

  let catCell;
  if (t.splits?.length) {
    catCell = el("button", { class: "split-pill", title: "Split transaction (click to edit)" }, `Split · ${t.splits.length}${t.splitsNeedReview ? " ⚠" : ""}`);
    catCell.onclick = () => toggle(t);
  } else {
    catCell = catSelect(t.category);
    if (t.categorySource && t.categorySource !== "user") catCell.title = `set by ${t.categorySource}`;
    catCell.onchange = () => { catCell.classList.toggle("uncat", !catCell.value); catCell.classList.toggle("archived", catCell.value === ARCHIVE_ID); commitEdit(t, { category: catCell.value || null }); };
  }

  const tr = el("tr", { class: `tx${expanded.has(t.id) ? " open" : ""}`, "data-id": t.id },
    el("td", {}, accountBadge(accts[t.accountId] || { id: t.accountId, name: t.accountId })),
    el("td", {}, fmtDate(t.date)),
    el("td", { title: t.description }, t.description),
    amountCell(t),
    el("td", { class: "edit" }, note),
    el("td", { class: `edit cat-cell${isSelected(t.id) ? " selected" : ""}` }, catCell),
    afterCell(t),
  );
  tr.onclick = (e) => { if (!e.target.closest("input, select, button, label, td.cat-cell")) toggle(t); };
  return tr;
}

/** While reviewing an AI run: the proposed category with a keep/skip checkbox. */
function afterCell(t) {
  const p = review()?.byKey.get(`${t.accountId}/${t.id}`);
  if (!p) return null;
  const cb = el("input", { type: "checkbox", checked: p.selected });
  cb.onchange = () => { toggleProposal(p.key, cb.checked); tr().classList.toggle("unselected", !cb.checked); };
  const tr = () => cb.closest("tr");
  const name = p.to === ARCHIVE_ID ? "Archive" : catIdx.get(p.to)?.name || p.to;
  return el("td", { class: `after-col${p.to === ARCHIVE_ID ? " muted" : ""}` }, el("label", { class: "cb after" }, cb, name));
}

/** Bank amount, or the counted amount with the bank amount struck through when overridden. */
function amountCell(t) {
  const n = trackedCents(t);
  if (n === t.amountCents) return el("td", { class: `num ${n > 0 ? "good" : ""}` }, fmtMoney(n));
  return el("td", { class: "num overridden", title: `Bank amount ${fmtMoney(t.amountCents)}, counted as ${fmtMoney(n)}` },
    el("s", { class: "muted" }, fmtMoney(t.amountCents)), " ", el("span", { class: n > 0 ? "good" : "" }, fmtMoney(n)));
}

function refreshRow(t) {
  const old = rowEls.get(t.id);
  if (!old) return;
  const tr = rowFor(t);
  old.replaceWith(tr);
  rowEls.set(t.id, tr);
  const next = tr.nextElementSibling;
  if (next?.classList.contains("detail")) next.replaceWith(detailRow(t));
}

/** Expand/collapse in place (no full re-render, keeps scroll position). */
function toggle(t) {
  const tr = rowEls.get(t.id);
  if (expanded.has(t.id)) {
    expanded.delete(t.id);
    tr.classList.remove("open");
    if (tr.nextElementSibling?.classList.contains("detail")) tr.nextElementSibling.remove();
  } else {
    expanded.add(t.id);
    tr.classList.add("open");
    tr.after(detailRow(t));
  }
}

function detailRow(t) {
  const a = byId()[t.accountId];
  const kv = (k, v) => (v == null || v === "" ? [] : [el("dt", {}, k), el("dd", {}, v)]);
  return el("tr", { class: "detail" }, el("td", { colspan: review() ? 7 : 6 },
    el("div", { class: "row", style: "align-items:flex-start; gap:32px; flex-wrap:nowrap" },
      el("dl", { class: "kv", style: "flex:1; margin:0; min-width:280px" },
        kv("Description", t.description),
        kv("Merchant", t.merchant),
        kv("Amount", fmtMoney(t.amountCents)),
        kv("Date", fmtDate(t.date)),
        kv("Posted", t.postedDate && t.postedDate !== t.date ? fmtDate(t.postedDate) : null),
        kv("Account", a ? `${a.name} …${a.last4 || "?"}` : t.accountId),
        kv("Bank reference", t.bankRef),
        kv("Imported", `${new Date(t.importedAt).toLocaleString()} · ${t.importId}`),
      ),
      el("div", { style: "flex:1.4" }, overrideEditor(t), splitEditor(t)),
    ),
  ));
}

// ---------- counted-amount override ----------
/** "Count this as $X": e.g. 0 for something reimbursed / not worth tracking, or only your share. */
function overrideEditor(t) {
  const sign = t.amountCents < 0 ? -1 : 1;
  const has = Number.isInteger(t.overrideCents);
  const input = el("input", { class: "split-amount", value: has ? (Math.abs(t.overrideCents) / 100).toFixed(2) : "", placeholder: (Math.abs(t.amountCents) / 100).toFixed(2), inputmode: "decimal" });
  const msg = el("span", { class: "muted" });
  const apply = (cents) => {
    try { commitEdit(t, { overrideCents: cents }); refreshRow(t); }
    catch (e) { msg.className = "bad"; msg.textContent = e.message; }
  };
  const set = el("button", {}, "Set");
  set.onclick = () => {
    const v = parseMoneyInput(input.value);
    if (v == null) { msg.className = "bad"; msg.textContent = "Enter an amount (0 to not count it)."; return; }
    apply(v * sign);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") set.click(); };
  const zero = el("button", { title: "Reimbursed, returned, or not worth tracking" }, "Don't count ($0)");
  zero.onclick = () => apply(0);
  const clear = has ? Object.assign(el("button", {}, "Use bank amount"), { onclick: () => apply(null) }) : null;
  return el("div", { class: "override-editor" },
    el("div", {}, el("b", {}, "Counted amount"), el("span", { class: "muted" }, has ? `  (bank: ${fmtMoney(t.amountCents)})` : "  Override what this counts as in the summary.")),
    el("div", { class: "row", style: "margin-top:4px" }, "$", input, set, zero, clear, msg));
}

// ---------- split editor ----------
function splitEditor(t) {
  const total = trackedCents(t);
  const sign = total < 0 ? -1 : 1;
  if (total === 0) return el("div", { class: "split-editor muted" }, "Counted as $0, so there's nothing to split.");
  const fromSaved = () => (t.splits || []).map((s) => ({
    id: s.id, category: s.category || "", note: s.note || "", remainder: !!s.remainder,
    amount: s.remainder ? "" : (Math.abs(s.amountCents) / 100).toFixed(2),
  }));
  let rows = fromSaved();
  const wrap = el("div", { class: "split-editor" });

  const toSplits = () => rows.map((r) => ({
    id: r.id, category: r.category || null, note: r.note.trim(), remainder: r.remainder,
    amountCents: r.remainder ? undefined : (parseMoneyInput(r.amount) ?? NaN) * sign,
  }));

  function draw() {
    wrap.innerHTML = "";
    if (!rows.length) {
      const b = el("button", {}, "Split transaction…");
      b.onclick = () => {
        rows = [
          { id: newId(), amount: "", category: t.category || "", note: "", remainder: false },
          { id: newId(), amount: "", category: "", note: "", remainder: true },
        ];
        draw();
      };
      wrap.append(el("div", { class: "muted", style: "margin-bottom:6px" }, "Split this into parts with their own categories, e.g. groceries + pharmacy."), b);
      return;
    }

    const remCells = new Map();
    const body = el("tbody", {}, rows.map((r, i) => {
      const amountCell = r.remainder
        ? el("span", { class: "rem-amount" })
        : el("input", { class: "split-amount", value: r.amount, placeholder: "0.00", inputmode: "decimal" });
      if (r.remainder) remCells.set(r.id, amountCell);
      else amountCell.oninput = () => { r.amount = amountCell.value; totals(); };
      const cat = catSelect(r.category, "split-select");
      cat.onchange = () => { r.category = cat.value; cat.classList.toggle("uncat", !cat.value); };
      const note = el("input", { class: "split-note", value: r.note, placeholder: "note" });
      note.oninput = () => { r.note = note.value; };
      const rem = el("button", { class: `rem-toggle${r.remainder ? " on" : ""}`, title: "This row gets whatever is left over" }, "Remaining");
      rem.onclick = () => {
        const turnOn = !r.remainder;
        rows.forEach((x) => { x.remainder = false; });
        r.remainder = turnOn;
        if (turnOn) r.amount = "";
        draw();
      };
      const del = el("button", { class: "icon", title: "Remove row" }, "✕");
      del.onclick = () => { rows.splice(i, 1); draw(); };
      return el("tr", {}, el("td", {}, "$", amountCell), el("td", {}, cat), el("td", {}, note), el("td", {}, rem), el("td", {}, del));
    }));

    const summary = el("div", { class: "split-summary" });
    const save = el("button", { class: "primary" }, "Save split");
    const add = el("button", {}, "+ Add row");
    add.onclick = () => { rows.push({ id: newId(), amount: "", category: "", note: "", remainder: false }); draw(); };
    const cancel = el("button", {}, "Cancel");
    cancel.onclick = () => { rows = fromSaved(); draw(); };
    const remove = t.splits?.length ? el("button", {}, "Remove split") : null;
    if (remove) remove.onclick = () => { commitEdit(t, { splits: [] }); refreshRow(t); };

    function totals() {
      const r = resolveSplits(total, toSplits());
      for (const s of r.splits) if (s.remainder) {
        const cell = remCells.get(s.id);
        if (cell) { cell.textContent = Number.isFinite(s.amountCents) ? (Math.abs(s.amountCents) / 100).toFixed(2) : "—"; cell.classList.toggle("bad", !r.ok); }
      }
      const incomplete = rows.some((x) => !x.remainder && parseMoneyInput(x.amount) == null);
      summary.className = `split-summary ${r.ok ? "good" : incomplete ? "muted" : "bad"}`;
      summary.textContent = r.ok
        ? `Adds up to ${fmtMoney(total)} ✓`
        : incomplete ? "Enter an amount on each row (or mark one as Remaining)."
        : r.unassignedCents ? `${fmtMoney(Math.abs(r.unassignedCents))} ${Math.sign(r.unassignedCents) === sign ? "left to assign" : "over"} · ${r.error}` : r.error;
      save.disabled = !r.ok || rows.length < 2;
      save.title = rows.length < 2 ? "A split needs at least two rows" : "";
      return r;
    }
    save.onclick = () => {
      const r = totals();
      if (!r.ok) return;
      commitEdit(t, { splits: r.splits });
      refreshRow(t);
    };

    wrap.append(
      el("div", { style: "margin-bottom:4px" }, el("b", {}, `Split ${fmtMoney(total)}`), t.splitsNeedReview ? el("span", { class: "warn" }, "  ⚠ amount changed when this posted; check the rows") : ""),
      el("table", { class: "split-table" }, body),
      summary,
      el("div", { class: "row", style: "margin-top:6px" }, add, save, cancel, remove),
    );
    totals();
  }
  draw();
  return wrap;
}

// ---------- category editor (Summary → Edit categories) ----------
let draft = null;

function openCategoryEditor() {
  draft = structuredClone(cats);
}

function closeCategoryEditor() {
  editingCategories = false;
  draft = null;
  renderSummary();
}

function usageCounts() {
  const n = {};
  for (const t of txns) {
    if (t.category) n[t.category] = (n[t.category] || 0) + 1;
    for (const s of t.splits || []) if (s.category) n[s.category] = (n[s.category] || 0) + 1;
  }
  return n;
}

// Drag & drop: grab a ☰ handle and drop the row where you want it. The DOM order is the source
// of truth while dragging; on drop the draft is rebuilt from it, so a category's group is simply
// whichever group it ends up under.
let drag = null; // { el, kind: "cat" | "group" }
const catOf = new WeakMap();   // row element  -> category object in draft
const groupOf = new WeakMap(); // group element -> group object in draft

function dragHandle(item, kind) {
  const h = el("span", { class: "drag-handle", title: "Drag to reorder" }, "☰");
  h.addEventListener("pointerdown", () => { item.draggable = true; });
  h.addEventListener("pointerup", () => { item.draggable = false; });
  item.addEventListener("dragstart", (e) => {
    if (e.target !== item) return; // a category row lives inside a group element
    drag = { el: item, kind };
    e.dataTransfer?.setData("text/plain", "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", (e) => {
    if (e.target !== item) return;
    item.draggable = false;
    item.classList.remove("dragging");
    if (drag?.el === item) { drag = null; syncDraftFromDom(); }
  });
  return h;
}

/** Moves the dragged element to the spot under the pointer within `container`. */
function dropInto(container, selector, e) {
  e.preventDefault();
  const others = [...container.querySelectorAll(`:scope > ${selector}`)].filter((x) => x !== drag.el);
  const before = others.find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  if (before) { if (before.previousElementSibling !== drag.el) container.insertBefore(drag.el, before); }
  else if (container.lastElementChild !== drag.el) container.append(drag.el);
}

function syncDraftFromDom() {
  const groupEls = [...$("summaryBody").querySelectorAll(".cat-groups > .cat-group")];
  draft.groups = groupEls.map((gEl) => {
    const g = groupOf.get(gEl);
    g.categories = [...gEl.querySelectorAll(".cat-row")].map((r) => catOf.get(r));
    return g;
  });
  drawCategoryEditor();
}

function drawCategoryEditor() {
  const box = $("summaryBody");
  box.innerHTML = "";
  const used = usageCounts();
  const allIds = () => [ARCHIVE_ID, ...draft.groups.flatMap((g) => g.categories.map((c) => c.id))];
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(cats);
  const markDirty = () => { $("catDirty").textContent = dirty() ? "Unsaved changes" : ""; };

  const groupsEl = el("div", { class: "cat-groups" }, draft.groups.map((g, gi) => {
    const gname = el("input", { class: "cat-group-name", value: g.name });
    gname.oninput = () => { g.name = gname.value; markDirty(); };
    const addCat = el("button", {}, "+ Category");
    addCat.onclick = () => { g.categories.push({ id: uniqueId("new_category", allIds()), name: "New category" }); drawCategoryEditor(); };
    const brk = el("button", { class: `icon break-toggle${g.sectionBreak ? " on" : ""}`, title: "Start a new section (with its own total) at this group", disabled: gi === 0 }, "Section break");
    brk.onclick = () => { if (g.sectionBreak) delete g.sectionBreak; else g.sectionBreak = true; drawCategoryEditor(); };
    const delGroup = el("button", { class: "icon", title: g.categories.length ? "Move or delete its categories first" : "Delete group", disabled: g.categories.length > 0 }, "✕");
    delGroup.onclick = () => { draft.groups.splice(gi, 1); drawCategoryEditor(); };

    const list = el("div", { class: "cat-list" }, g.categories.map((c, ci) => {
      const name = el("input", { value: c.name, size: 30 });
      name.oninput = () => {
        c.name = name.value;
        // brand-new categories take their id from the first real name
        if (!cats.groups.some((x) => x.categories.some((y) => y.id === c.id)) && name.value.trim()) c.id = uniqueId(name.value, allIds().filter((id) => id !== c.id));
        markDirty();
      };
      const n = used[c.id] || 0;
      const del = el("button", { class: "icon", title: n ? `Used by ${n} transactions. Recategorize them first.` : "Delete category", disabled: n > 0 }, "✕");
      del.onclick = () => { g.categories.splice(ci, 1); drawCategoryEditor(); };
      const row = el("div", { class: "row cat-row" });
      row.append(dragHandle(row, "cat"), name, el("span", { class: "muted", style: "min-width:60px" }, n ? `${n} used` : ""), del);
      catOf.set(row, c);
      return row;
    }));
    if (!g.categories.length) list.append(el("div", { class: "muted cat-empty" }, "Drag categories here"));

    const groupEl = el("div", { class: `cat-group${g.sectionBreak && gi > 0 ? " section-start" : ""}` });
    groupEl.append(el("div", { class: "row" }, dragHandle(groupEl, "group"), gname, addCat, brk, delGroup), list);
    groupOf.set(groupEl, g);
    // a category dragged anywhere over a group (even an empty one) lands in that group's list
    groupEl.addEventListener("dragover", (e) => { if (drag?.kind === "cat") { list.querySelector(".cat-empty")?.remove(); dropInto(list, ".cat-row", e); } });
    return groupEl;
  }));
  groupsEl.addEventListener("dragover", (e) => { if (drag?.kind === "group") dropInto(groupsEl, ".cat-group", e); });

  const addGroup = el("button", {}, "+ Group");
  addGroup.onclick = () => { draft.groups.push({ id: uniqueId("group", draft.groups.map((g) => g.id)), name: "New group", categories: [] }); drawCategoryEditor(); };
  const onSave = () => {
    try { validateCategories(draft); } catch (e) { setStatus(e.message, "bad"); return; }
    if (dirty()) {
      const doc = structuredClone(draft);
      setCategories(doc);
      queueOp({ type: "categories", doc });
    }
    setStatus("");
    closeCategoryEditor();
  };
  const actions = () => [
    Object.assign(el("button", { class: "primary" }, "Save categories"), { onclick: onSave }),
    Object.assign(el("button", {}, "Cancel"), { onclick: closeCategoryEditor }),
  ];

  box.append(el("div", { class: "card" },
    el("div", { class: "row", style: "justify-content:space-between" }, el("h2", { style: "margin:0" }, "Edit categories"), el("span", { id: "catDirty", class: "warn" }, dirty() ? "Unsaved changes" : "")),
    el("div", { class: "muted", style: "margin:4px 0 8px" }, "Drag ☰ to reorder groups and categories, or to move a category into another group. This order is used in the summary and the dropdowns. Renaming keeps existing transactions linked. \"Section break\" starts a new block with its own total (e.g. investments)."),
    el("div", { class: "row", style: "margin-bottom:6px" }, actions()),
    groupsEl,
    el("div", { class: "row", style: "margin-top:10px" }, addGroup, actions()),
  ));
}

// ---------- settings tab ----------
function renderSettings() {
  renderConnection();
  renderAiSettings();
  renderAccounts();
}

async function renderAiSettings() {
  const box = $("aiSettingsPanel");
  const c = await call("getConnection");
  box.innerHTML = "";
  const key = el("input", { id: "sAnthropicKey", type: "password", autocomplete: "off", placeholder: c.hasAnthropicKey ? "saved (leave blank to keep)" : "sk-ant-…" });
  const model = el("select", { id: "sAiModel" }, Object.entries(MODELS).map(([id, m]) => el("option", { value: id }, m.label)));
  model.value = c.aiModel;
  const save = el("button", { class: "primary" }, "Save");
  const forget = el("button", { disabled: !c.hasAnthropicKey }, "Forget key");
  const msg = el("span", { class: "muted" });
  save.onclick = async () => {
    await call("saveConnection", { settings: { anthropicKey: key.value, aiModel: model.value } });
    await renderAiSettings();
    $("aiSettingsPanel").querySelector(".row:last-child span").textContent = "Saved ✓";
  };
  forget.onclick = async () => { await call("saveConnection", { settings: {}, forget: ["anthropicKey"] }); renderAiSettings(); };
  box.append(
    el("h2", { style: "margin-top:0" }, "Claude API (AI categorize)"),
    el("div", { class: "muted" }, "Your key is saved only in this browser and is sent only to api.anthropic.com. Haiku is the cheapest model and is usually enough for categorizing."),
    el("div", { class: "settings-grid" },
      el("div", {}, el("label", { for: "sAnthropicKey" }, "Anthropic API key"), key),
      el("div", {}, el("label", { for: "sAiModel" }, "Model"), model)),
    el("div", { class: "row", style: "margin-top:10px" }, save, forget, msg),
  );
}

async function renderConnection() {
  const box = $("settingsPanel");
  const c = await call("getConnection");
  box.innerHTML = "";
  const field = (id, label, attrs = {}) => el("div", {}, el("label", { for: id }, label), el("input", { id, ...attrs }));
  box.append(
    el("h2", { style: "margin-top:0" }, "Data repo connection"),
    el("div", { class: "muted" }, "Saved only in this browser (localStorage for this site), never in any repo. Use a fine-grained token limited to your data repo, with Contents: Read and write."),
    el("div", { class: "settings-grid" },
      field("sOwner", "GitHub owner", { value: c.ghOwner }),
      field("sRepo", "Private data repo", { value: c.ghRepo, placeholder: "finance-data" }),
      field("sBranch", "Branch", { value: c.ghBranch, placeholder: "main" }),
      field("sToken", "GitHub token", { type: "password", autocomplete: "off", placeholder: c.hasToken ? "saved (leave blank to keep)" : "github_pat_…" }),
    ),
  );
  const save = el("button", { class: "primary" }, "Save & connect");
  const forget = el("button", { disabled: !c.hasToken }, "Forget token");
  const msg = el("div", { class: "status" });
  box.append(el("div", { class: "row", style: "margin-top:10px" }, save, forget), msg);
  const show = (text, cls) => { msg.className = `status ${cls}`; msg.textContent = text; };

  save.onclick = async () => {
    save.disabled = true;
    show("Connecting…", "muted");
    try {
      await call("saveConnection", { settings: { ghOwner: $("sOwner").value, ghRepo: $("sRepo").value, ghBranch: $("sBranch").value || "main", ghToken: $("sToken").value } });
      $("sToken").value = "";
      $("sToken").placeholder = "saved (leave blank to keep)";
      forget.disabled = false;
      const r = await call("testConnection");
      const problems = [!r.private && "REPO IS PUBLIC: make it private", !r.canPush && "token can't write"].filter(Boolean);
      show(`Connected to ${r.fullName}.${problems.length ? " ⚠ " + problems.join("; ") : ""}`, problems.length ? "bad" : "good");
      await load();
    } catch (e) { show(e.message, "bad"); }
    save.disabled = false;
  };
  forget.onclick = async () => {
    await call("saveConnection", { settings: {}, forget: ["ghToken"] });
    forget.disabled = true;
    $("sToken").placeholder = "github_pat_…";
    show("Token removed from this browser.", "muted");
  };
}

function renderAccounts() {
  const box = $("accountPanel");
  box.innerHTML = "";
  box.append(el("h2", { style: "margin-top:0" }, "Accounts"));
  if (!accounts.length) { box.append(el("div", { class: "muted" }, "No accounts yet. They're created when you save a page from the extension.")); return; }
  const counts = {};
  for (const t of txns) counts[t.accountId] = (counts[t.accountId] || 0) + 1;
  box.append(el("div", { class: "muted", style: "margin-bottom:6px" }, "The color is used for the account's badge in the transaction list."), el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Color"), el("th", {}, "Badge"), el("th", {}, "Name"), el("th", {}, "Type"), el("th", { class: "num" }, "Transactions"), el("th", {}, ""))),
    el("tbody", {}, accounts.map((a) => {
      const color = el("input", { type: "color", value: accountColor(a) });
      const name = el("input", { value: a.name, size: 36 });
      const badgeCell = el("td", {}, accountBadge(a));
      color.oninput = () => { badgeCell.innerHTML = ""; badgeCell.append(accountBadge({ ...a, color: color.value })); };
      const save = el("button", {}, "Save");
      save.onclick = async () => {
        save.disabled = true;
        try {
          await call("upsertAccount", { account: { ...a, color: color.value, name: name.value.trim() || a.name } });
          await load();
        } catch (e) { setStatus(e.message, "bad"); save.disabled = false; }
      };
      return el("tr", {}, el("td", {}, color), badgeCell, el("td", {}, name), el("td", {}, a.type), el("td", { class: "num" }, counts[a.id] || 0), el("td", {}, save));
    })),
  ));
}

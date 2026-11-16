// Web dashboard (served by GitHub Pages). Reads/writes the private data repo directly with the
// token saved in Settings. The shared data code lives in ../extension/src/lib/.
// Tabs: #summary (per category per month with prediction rows, + category editor), #transactions, #settings.
import { fmtMoney, fmtDate, el, accountBadge, accountColor } from "../extension/src/lib/ui.js";
import { resolveSplits, parseMoneyInput } from "../extension/src/lib/splits.js";
import { categoryIndex, uniqueId, validateCategories, archivedAt, ARCHIVE_ID } from "../extension/src/lib/categories.js";
import { emptyBudget, budgetEntry, entryMonths, entryAvg, setMonthly, setMonth, rebaseBudget, fyOf, fyPos, fyMonth, fyMonthNames, fyRangeText, DEFAULT_FY_START } from "../extension/src/lib/budget.js";
import { applyState, editableState, trackedCents } from "../extension/src/lib/edits.js";
import { onStorageChanged } from "../extension/src/lib/platform.js";
import { OUTBOX_KEY, pendingCount } from "./lib/outbox.js";
import { call } from "./lib/backend.js";
import { MODELS } from "./lib/ai.js";
import { initCellSelect, isSelected, isCopied, render as renderSelection } from "./cell-select.js";
import { initAi, renderAiPanel, renderLogs, isPanelOpen, openPanel, review, toggleProposal } from "./ai-panel.js";
import { catPicker, pickerIds, describeSelection, UNCAT } from "./cat-picker.js";

const $ = (id) => document.getElementById(id);
let accounts = [], txns = [], cats = { version: 2, groups: [] }, catIdx = new Map(), catOptionsHtml = "";
let budget = emptyBudget(); // predicted amounts (budget.json)
let loaded = false;
const expanded = new Set();
const rowEls = new Map(); // txn id -> <tr>
const byId = () => Object.fromEntries(accounts.map((a) => [a.id, a]));
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Financial year: starts in month fyStart() and is named by the year it ends in (Nov 2026 - Oct 2027 = "2027").
const fyStart = () => budget.fyStart || DEFAULT_FY_START;
const fyLabel = (date) => fyOf(date, fyStart());

function setStatus(msg, cls = "") { $("status").className = `status ${cls}`; $("status").textContent = msg; }

// ---------- AI categorize (see ai-panel.js) ----------
initAi({
  get txns() { return txns; }, get cats() { return cats; }, get accounts() { return accounts; }, get catIdx() { return catIdx; },
  get loaded() { return loaded; },
  call, setStatus,
  /** Category-only edits that keep note, splits and counted amount. */
  setCategories: (items) => setTxCategories(items),
  shownRows: () => shownRows(),
  filterLabel: () => filterLabel(),
  onReviewChange: () => { if (tab === "transactions") renderTransactions(); else if (tab === "logs") renderLogs(); },
});

// ---------- multi-select + copy/paste of categories (see cell-select.js) ----------
let displayedRows = [];
initCellSelect({
  rows: () => displayedRows,
  isActive: () => tab === "transactions" && !review(),
  setCategories: (items) => { const n = setTxCategories(items); for (const { t } of items) refreshRow(t); return n; },
});

// ---------- summary view: prediction rows shown or hidden (remembered in this browser) ----------
const VIEW_KEY = "fd:summaryView";
const view = (() => { try { return { predict: JSON.parse(localStorage.getItem(VIEW_KEY) || "{}").predict !== false }; } catch (_) { return { predict: true }; } })();
function setView(patch) {
  const anchor = "predict" in patch && patch.predict !== view.predict ? summaryAnchor() : null;
  Object.assign(view, patch);
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) {}
  renderSummary();
  if (anchor) restoreSummaryAnchor(anchor);
}

// Showing/hiding predictions keeps your place: the row just under the pinned column header stays
// there (prediction rows come and go above it, so a raw scroll offset would drift).
const summaryHead = () => document.querySelector("#summaryBody .sum-head");
const summaryRows = () => [...document.querySelectorAll("#summaryBody tr[data-key]")];
function summaryAnchor() {
  const head = summaryHead();
  if (!head) return null;
  const top = head.getBoundingClientRect().bottom;
  const row = summaryRows().find((tr) => tr.getBoundingClientRect().bottom > top + 1);
  return { key: row?.dataset.key, off: row ? row.getBoundingClientRect().top - top : 0 };
}
function restoreSummaryAnchor(a) {
  const head = summaryHead();
  const row = a.key && summaryRows().find((tr) => tr.dataset.key === a.key);
  if (!head || !row) return;
  window.scrollBy(0, row.getBoundingClientRect().top - head.getBoundingClientRect().bottom - a.off);
}
$("sumPred").onclick = () => setView({ predict: !view.predict });


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
    [accounts, txns, cats, budget] = st.initialized
      ? await Promise.all([call("listAccounts"), call("getAllTransactions"), call("getCategories"), call("getBudget")])
      : [[], [], st.configured ? await call("getCategories") : cats, emptyBudget()];
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
  if (outboxState.budget) budget = outboxState.budget.doc;
  renderSaveState();
  setCategories(cats);
  loaded = true;

  if (!st.configured) { setStatus("Not connected to your data repo yet. Fill in the connection below.", "warn"); showTab("settings"); }
  else if (!st.initialized) setStatus(`${st.repo} has no data yet. Save a page from the extension to set it up.`, "warn");
  else if (!st.importCount) setStatus("No imports yet. In the extension, on a bank page: Extract → Compare with saved → Save.", "warn");
  else setStatus("");

  fillAccountSelect($("filterAccount"));
  fillAccountSelect($("sumAccount"));
  fillYearSelect();
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
    `<optgroup label="${esc(g.name)}">${g.categories.map((c) => `<option value="${esc(c.id)}"${c.archivedFrom ? ` data-from="${esc(c.archivedFrom)}"` : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`).join("")
    + `<optgroup label="Hidden"><option value="${ARCHIVE_ID}">Archive</option></optgroup>`;
}

/**
 * A category dropdown for a transaction dated `date`. Categories archived by then aren't offered,
 * except the one it's already in, which is marked and shown red so it gets reassigned.
 */
function catSelect(value, cls = "cell-select", date = null) {
  const s = document.createElement("select");
  s.className = cls;
  s.innerHTML = catOptionsHtml;
  if (date) for (const o of s.querySelectorAll("option[data-from]")) {
    if (date.slice(0, 7) < o.dataset.from) continue;
    if (o.value === value) o.textContent += " (archived)";
    else o.remove();
  }
  if (value && !catIdx.has(value)) s.append(new Option(`(deleted: ${value})`, value));
  s.value = value || "";
  markCatSelect(s, date);
  return s;
}
function markCatSelect(s, date) {
  s.classList.toggle("uncat", !s.value); // faint text = still to do
  s.classList.toggle("archived", s.value === ARCHIVE_ID);
  const c = catIdx.get(s.value);
  const stray = !!date && archivedAt(c, date);
  s.classList.toggle("stray", stray);
  s.title = stray ? `${c.name} is archived from ${monthText(c.archivedFrom)}. Pick another category.` : "";
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

/**
 * Category-only edits for many transactions at once (paste, AI apply): applied in memory now,
 * buffered with ONE storage write. Note, splits and counted amount are untouched; split rows are skipped.
 */
function setTxCategories(items) {
  const ops = [];
  for (const { t, category } of items) {
    if (t.splits?.length || (t.category || null) === (category || null)) continue;
    applyState(t, { ...editableState(t), category: category || null });
    ops.push({ type: "tx", entry: { accountId: t.accountId, id: t.id, date: t.date, state: editableState(t) } });
  }
  if (ops.length) call("queueEdits", { ops }).catch((e) => setStatus(`Couldn't buffer the edits locally: ${e.message}`, "bad"));
  return ops.length;
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
/** Mixes a group's color with white (a = share of the color) so sticky cells stay opaque. */
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16), mix = (c) => Math.round(c * a + 255 * (1 - a));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
/** Colors a summary row by its group: a stripe on the label, the group row tinted, its categories lightly. */
function paint(tr, g, kind, key) {
  if (key) tr.dataset.key = key;
  if (!g?.color) return tr;
  tr.style.setProperty("background", tint(g.color, kind === "group" ? 0.2 : 0.07), "important"); // beats tr.group-row's default
  tr.querySelector("td.label").style.boxShadow = `inset 4px 0 0 ${g.color}`;
  return tr;
}

/** Net outflow in cents per category per month of financial year `year` (index 0 = its first month):
 *  Map(categoryId | UNCAT -> number[12]). Splits count per part. */
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
    if (fyLabel(t.date) !== year || (accountId && t.accountId !== accountId)) continue;
    const m = fyPos(t.date, fyStart());
    months.add(m);
    if (t.splits?.length) for (const s of t.splits) add(s.category, m, s.amountCents);
    else if (trackedCents(t)) add(t.category, m, trackedCents(t));
  }
  return { sums, months: [...months].sort((a, b) => a - b) };
}

const sumArr = (arrs) => arrs.reduce((acc, a) => (a ? acc.map((v, i) => v + a[i]) : acc), Array(12).fill(0));
const dollars = (cents) => "$" + Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
/** Whole dollars; money that came in (negative spending) shows green. */
function moneyCell(cents, attrs = {}) {
  const td = el("td", { class: `num${cents < 0 ? " good" : ""}${attrs.class ? ` ${attrs.class}` : ""}` });
  if (cents) {
    td.textContent = dollars(cents);
    td.title = attrs.title || `${cents < 0 ? "net money in " : ""}${fmtMoney(Math.abs(cents))}`;
  }
  if (attrs.onclick) { td.classList.add("link"); td.onclick = attrs.onclick; }
  return td;
}

function fillYearSelect() {
  const ys = $("sumYear");
  const keep = ys.value;
  const current = fyLabel(new Date().toISOString().slice(0, 10));
  const years = [...new Set([...txns.map((t) => fyLabel(t.date)), current, String(+current + 1), ...Object.keys(budget.years)])].sort().reverse();
  ys.innerHTML = "";
  for (const y of years) ys.append(new Option(y, y));
  ys.value = years.includes(keep) ? keep : current;
  showYearRange();
}

function showYearRange() {
  const y = $("sumYear").value;
  $("sumRange").textContent = y && fyStart() !== 1 ? fyRangeText(y, fyStart()) : "";
}

function renderSummary() {
  showYearRange();
  $("sumPred").hidden = editingCategories;
  $("sumPred").classList.toggle("on", view.predict);
  $("sumPred").setAttribute("aria-pressed", String(view.predict));
  $("sumAccount").hidden = editingCategories;
  $("editCategories").hidden = editingCategories;
  const body = $("summaryBody");
  if (editingCategories) { drawCategoryEditor(); return; }
  body.innerHTML = "";
  if (!loaded) return;
  renderTable(body);
}

// A standalone table per group (same columns, so they line up), with one column header pinned under
// the top bar; the page itself scrolls. A group's header row is its subtotal: each cell has the actual
// sum and, with Predictions on, the predicted sum under it. With Predictions on, each category's actual
// row is followed by a prediction row with an entry box per month; the Monthly box sits in the last
// column so the month columns don't move: it fills and locks all 12 months (lib/budget.js).
// Archived categories (archivedFrom) show only in years they were still in use (or still have money
// in them); their archived months are grayed out, and money still in them then is red (reassign it).
const centsText = (c) => (c == null ? "" : c % 100 ? (c / 100).toFixed(2) : String(c / 100));
const monthText = (ym) => `${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
function renderTable(body) {
  const year = $("sumYear").value;
  const acct = $("sumAccount").value;
  const showPred = view.predict;
  const { sums, months } = monthlyTotals(year, acct);
  const cols = [...Array(12).keys()]; // every month of the financial year, including ones still ahead
  const yms = cols.map((m) => fyMonth(year, m, fyStart()));
  // the average covers the months that have data so far (first to last), not the empty future ones
  const avgDiv = months.length ? months.at(-1) - months[0] + 1 : 0;
  const goto = (category, m) => () => openTransactions({ category, date: m == null ? `fy:${year}` : yms[m], account: acct });
  const names = fyMonthNames(fyStart());
  const catArr = (id) => sums.get(id) || Array(12).fill(0);
  const off = (c, m) => archivedAt(c, yms[m]);
  // shown if in use for at least one month of this year, or if money is still in it
  const visible = (c) => !c.archivedFrom || c.archivedFrom > yms[0] || catArr(c.id).some((v) => v);
  const entry = (id) => budgetEntry(budget, year, id);
  // predictions for archived months don't count (they're kept, in case the category comes back)
  const predMonths = (c) => entryMonths(entry(c.id)).map((v, m) => (off(c, m) ? null : v));
  const predAvg = (cs) => cs.reduce((s, c) => {
    const v = predMonths(c).filter((x) => x != null);
    return s + (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / 12) : 0);
  }, 0);
  const setTd = (td, cents) => { td.textContent = cents ? dollars(cents) : ""; };

  // live cells, recomputed after every prediction edit
  const catRows = [];  // { c, monthly, months: [input×12], total }
  const aggRows = [];  // { cs, months: [el×12], total }: predicted sums in a group's header row
  const avgCells = []; // { cs, td }: the "Predicted / mo" column
  const refresh = () => {
    for (const r of catRows) {
      const e = entry(r.c.id);
      const vals = entryMonths(e);
      const locked = e?.monthly != null;
      if (document.activeElement !== r.monthly) r.monthly.value = centsText(e?.monthly ?? null);
      r.months.forEach((inp, m) => {
        if (off(r.c, m)) { inp.disabled = true; inp.value = ""; inp.title = `Archived from ${monthText(r.c.archivedFrom)}`; return; }
        inp.readOnly = locked;
        inp.title = locked ? "Set by Monthly (far right). Clear it to edit single months." : `Predicted, ${names[m]} ${yms[m].slice(0, 4)}`;
        if (document.activeElement !== inp || locked) inp.value = centsText(vals[m]);
      });
      setTd(r.total, predMonths(r.c).reduce((a, v) => a + (v || 0), 0));
    }
    for (const r of aggRows) {
      const per = r.cs.map(predMonths);
      r.months.forEach((x, m) => setTd(x, per.reduce((a, v) => a + (v[m] || 0), 0)));
      setTd(r.total, per.reduce((a, v) => a + v.reduce((x, y) => x + (y || 0), 0), 0));
      r.tr.classList.toggle("no-pred", !r.total.textContent); // nothing predicted: one line
    }
    for (const { cs, td } of avgCells) {
      const v = predAvg(cs);
      setTd(td, v);
      td.title = v ? `Predicted ${fmtMoney(v)} a month` : "";
    }
  };
  const commit = (next) => {
    if (JSON.stringify(next) === JSON.stringify(budget)) { refresh(); return; }
    budget = next;
    queueOp({ type: "budget", doc: budget });
    refresh();
  };
  /** Parses an input; blank = clear. Bad input is put back and reported. */
  const read = (inp, prev) => {
    const raw = inp.value.trim();
    if (!raw) return { ok: true, cents: null };
    const cents = parseMoneyInput(raw);
    if (cents == null) { setStatus(`"${raw}" isn't an amount. Use numbers like 120 or 45.50.`, "bad"); inp.value = centsText(prev); return { ok: false }; }
    setStatus("");
    return { ok: true, cents };
  };
  // Enter moves to the next prediction row in the same column (across groups), like a spreadsheet
  const onKey = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = [...body.querySelectorAll(`input[data-col="${e.target.dataset.col}"]:not(:disabled)`)];
    const next = inputs[inputs.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
    if (next) { next.focus(); next.select(); } else e.target.blur();
  };

  const labelCell = (label, category, archived, noteCat) => el("td", { class: "label" }, noteCat ? noteButton(noteCat) : null, category
    ? Object.assign(el("a", { href: "#transactions" }, label), { onclick: (e) => { e.preventDefault(); goto(category, null)(); } })
    : label, archived ? el("span", { class: "archived-tag", title: `Archived from ${monthText(archived)}` }, "archived") : null);
  /** Adds the predicted sum under the actual amount in a group header cell. */
  const withPred = (td) => {
    if (!td.textContent) td.prepend(el("span", { class: "agg-blank" })); // holds the actual line, so predicted sums all sit on line 2
    const p = el("div", { class: "pred agg-pred" });
    td.append(p);
    return p;
  };
  /**
   * An actual row: 12 months, Total, Avg / mo, Predicted / mo (and an empty Monthly cell).
   * offAt(m): month m is archived (grayed). strayAt(m): money sits in an archived category that month (red).
   * aggCs: a group header, which also shows the predicted sums of these categories.
   */
  const line = (label, arr, { cls = "", category = null, predCs = null, offAt = () => false, strayAt = () => false, archived = null, aggCs = null, noteCat = null } = {}) => {
    const total = arr.reduce((a, b) => a + b, 0);
    const predTd = el("td", { class: "num pred pred-col" });
    if (predCs) avgCells.push({ cs: predCs, td: predTd });
    const monthTds = cols.map((m) => {
      const stray = !!arr[m] && strayAt(m);
      const td = moneyCell(arr[m], { ...(category ? { onclick: goto(category, m) } : {}), ...(stray ? { title: `${fmtMoney(Math.abs(arr[m]))} in an archived category: reassign it` } : {}) });
      if (offAt(m)) td.classList.add("off");
      if (stray) td.classList.add("stray");
      return td;
    });
    const totalTd = moneyCell(total, { class: "total" });
    const agg = aggCs && showPred ? { cs: aggCs, months: monthTds.map(withPred), total: withPred(totalTd) } : null;
    const tr = el("tr", { class: cls }, labelCell(label, category, archived, noteCat), monthTds, totalTd,
      moneyCell(avgDiv ? Math.round(total / avgDiv) : 0, { class: "avg" }),
      predTd, showPred ? el("td", { class: "monthly-col" }) : null);
    if (agg) aggRows.push({ ...agg, tr });
    return tr;
  };
  /** A category's prediction row: an entry box per month, the predicted total, and Monthly at the far right. */
  const predCatLine = (c) => {
    const monthly = el("input", { class: "pred-input monthly", inputmode: "decimal", placeholder: "—", "data-col": "monthly", "aria-label": `${c.name} monthly prediction`, title: "Fills and locks all 12 months" });
    monthly.onchange = () => {
      const r = read(monthly, entry(c.id)?.monthly ?? null);
      if (r.ok) commit(setMonthly(budget, year, c.id, r.cents));
    };
    const inputs = names.map((name, m) => {
      const inp = el("input", { class: "pred-input", inputmode: "decimal", "data-col": String(m), "aria-label": `${c.name} ${name} prediction` });
      inp.onchange = () => {
        if (inp.readOnly || inp.disabled) { refresh(); return; }
        const r = read(inp, entryMonths(entry(c.id))[m]);
        if (r.ok) commit(setMonth(budget, year, c.id, m, r.cents));
      };
      return inp;
    });
    for (const i of [...inputs, monthly]) i.addEventListener("keydown", onKey);
    const row = { c, monthly, months: inputs, total: el("td", { class: "num pred total" }) };
    catRows.push(row);
    return el("tr", { class: "pred-row" }, el("td", { class: "label pred-label" }, "predicted"),
      inputs.map((i, m) => el("td", { class: `pcell${off(c, m) ? " off" : ""}` }, i)),
      row.total, el("td"), el("td", { class: "pred-col" }), el("td", { class: "pcell monthly-col" }, monthly));
  };

  // identical fixed column widths in every table, so the groups line up under the one header
  const colgroup = () => el("colgroup", {}, el("col", { class: "c-label" }), cols.map(() => el("col")),
    el("col", { class: "c-total" }), el("col", { class: "c-avg" }), el("col", { class: "c-pred" }), showPred ? el("col", { class: "c-monthly" }) : null);
  const tableCls = `summary${showPred ? " with-pred" : ""}`;
  const block = (rows, cls = "") => el("div", { class: `card table-card sum-block${cls}` }, el("table", { class: tableCls }, colgroup(), el("tbody", {}, rows)));

  const head = el("div", { class: "card table-card sum-head" }, el("table", { class: tableCls }, colgroup(),
    el("thead", {}, el("tr", {}, el("th", { class: "label" }, "Category"),
      cols.map((m) => el("th", { class: "num", title: yms[m] }, names[m])),
      el("th", { class: "num total" }, "Total"),
      el("th", { class: "num avg", title: avgDiv ? `Average over the ${avgDiv} month${avgDiv === 1 ? "" : "s"} with data so far` : "No transactions yet" }, "Avg / mo"),
      el("th", { class: "num pred", title: "Predicted average per month: Monthly, or the year's predicted months / 12" }, "Predicted / mo"),
      showPred ? el("th", { class: "num pred monthly-col", title: "Type an amount here to fill and lock all 12 predicted months. Leave it blank to enter single months (one-offs)." }, "Monthly") : null))));

  const blocks = [];
  cats.groups.forEach((g, gi) => {
    const cs = g.categories.filter(visible);
    if (g.categories.length && !cs.length) return; // every category archived before this year
    const allOff = (m) => cs.length > 0 && cs.every((c) => off(c, m));
    const anyStray = (m) => cs.some((c) => off(c, m) && catArr(c.id)[m]);
    const rows = [paint(line(g.name, sumArr(cs.map((c) => catArr(c.id))), { cls: "group-row", category: `g:${g.id}`, predCs: cs, aggCs: cs, offAt: allOff, strayAt: anyStray }), g, "group", `g:${g.id}`)];
    for (const c of cs) {
      rows.push(paint(line(c.name, catArr(c.id), { cls: `cat-line${c.archivedFrom ? " archived-cat" : ""}`, category: c.id, predCs: [c], offAt: (m) => off(c, m), strayAt: (m) => off(c, m), archived: c.archivedFrom || null, noteCat: c }), g, "cat", c.id));
      if (showPred) rows.push(paint(predCatLine(c), g, "cat"));
    }
    blocks.push(block(rows, g.sectionBreak && gi > 0 ? " section-start" : ""));
  });
  if (sums.has(UNCAT)) blocks.push(block([line("Uncategorized", sums.get(UNCAT), { cls: "uncat-row", category: UNCAT })], " section-start"));

  body.append(el("div", { class: "sum-tables" }, head, blocks));
  pinSummaryHead();
  refresh();
}
// a sheet of paper with a pencil
const NOTE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8"/><path d="M5 7h2.5M5 9.5h4.5M5 12h4.5"/><path d="M13 1.8l1.2 1.2-5 5-1.7.5.5-1.7z"/></svg>';
// ---------- category notes: the note icon at the left of each category row on the Summary ----------
// Stored as `note` on the category in categories.json (saved through the outbox like other category edits).
function noteButton(c) {
  const b = el("button", { class: `note-btn${c.note ? " has-note" : ""}`, type: "button", "aria-label": `Note for ${c.name}` });
  b.innerHTML = NOTE_ICON;
  b.title = c.note ? c.note : "Add a note";
  b.onclick = (e) => { e.stopPropagation(); openNoteEditor(c.id, b); };
  return b;
}
let notePop = null;
function closeNoteEditor(save) {
  if (!notePop) return;
  const { pop, id, ta } = notePop;
  notePop = null;
  pop.remove();
  if (save) setCategoryNote(id, ta.value);
}
function openNoteEditor(id, anchor) {
  const again = notePop?.id === id;
  closeNoteEditor(true);
  if (again) return; // clicking the icon again closes it
  const c = catIdx.get(id);
  if (!c) return;
  const ta = el("textarea", { rows: 4, placeholder: `Note for ${c.name}…`, maxlength: 2000 });
  ta.value = c.note || "";
  ta.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeNoteEditor(false); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeNoteEditor(true); }
  };
  const save = Object.assign(el("button", { class: "primary", type: "button" }, "Save"), { onclick: () => closeNoteEditor(true) });
  const cancel = Object.assign(el("button", { type: "button" }, "Cancel"), { onclick: () => closeNoteEditor(false) });
  const pop = el("div", { class: "note-pop" }, el("div", { class: "note-pop-title" }, c.name), ta,
    el("div", { class: "row" }, save, cancel, el("span", { class: "muted small" }, "Ctrl+Enter saves · Esc cancels")));
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left + window.scrollX}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  document.body.append(pop);
  notePop = { pop, id, ta, anchor };
  ta.focus();
}
// clicking elsewhere saves and closes, like a spreadsheet cell comment
document.addEventListener("mousedown", (e) => { if (notePop && !notePop.pop.contains(e.target) && e.target !== notePop.anchor) closeNoteEditor(true); });
function setCategoryNote(id, text) {
  const doc = structuredClone(cats);
  const c = doc.groups.flatMap((g) => g.categories).find((x) => x.id === id);
  if (!c) return;
  const note = text.trim();
  if ((c.note || "") === note) return;
  if (note) c.note = note; else delete c.note;
  try { validateCategories(doc); } catch (e) { setStatus(e.message, "bad"); return; }
  setCategories(doc);
  queueOp({ type: "categories", doc });
  for (const tr of document.querySelectorAll("#summaryBody tr[data-key]")) {
    const b = tr.dataset.key === id && tr.querySelector(".note-btn");
    if (!b) continue;
    b.classList.toggle("has-note", !!note);
    b.title = note || "Add a note";
  }
}

/** The column header sticks just under the (sticky) top bar. */
function pinSummaryHead() {
  document.documentElement.style.setProperty("--topbar-h", `${document.querySelector(".topbar")?.offsetHeight || 0}px`);
}
window.addEventListener("resize", pinSummaryHead);

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
  let fy = null;
  for (const ym of months) {
    if (fyLabel(ym) !== fy) {
      fy = fyLabel(ym);
      sel.append(new Option(fyStart() === 1 ? `All of ${fy}` : `All of ${fy} (${fyRangeText(fy, fyStart())})`, `fy:${fy}`));
    }
    sel.append(new Option(`${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`, ym));
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  $("dateRange").hidden = sel.value !== "custom";
}

function inDates(t) {
  const v = $("filterDate").value;
  if (v.startsWith("fy:")) return fyLabel(t.date) === v.slice(3);
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
      el("col", { style: `width:${narrow ? 190 : 240}px` }), // category (incl. the blank strip for selecting)
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
    catCell = catSelect(t.category, "cell-select", t.date);
    if (t.categorySource && t.categorySource !== "user" && !catCell.title) catCell.title = `set by ${t.categorySource}`;
    catCell.onchange = () => { markCatSelect(catCell, t.date); commitEdit(t, { category: catCell.value || null }); };
  }

  const tr = el("tr", { class: `tx${expanded.has(t.id) ? " open" : ""}`, "data-id": t.id },
    el("td", {}, accountBadge(accts[t.accountId] || { id: t.accountId, name: t.accountId })),
    el("td", {}, fmtDate(t.date)),
    el("td", { title: t.description }, t.description),
    amountCell(t),
    el("td", { class: "edit" }, note),
    el("td", { class: `edit cat-cell${isSelected(t.id) ? " selected" : ""}${isCopied(t.id) ? " copied" : ""}`, title: "Drag here to select several · Ctrl+C / Ctrl+V" }, catCell),
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
      const cat = catSelect(r.category, "split-select", t.date);
      cat.onchange = () => { r.category = cat.value; markCatSelect(cat, t.date); };
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
  draft.groups = [...$("summaryBody").querySelectorAll(".cat-groups > .cat-group")].map((gEl) => {
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

  const groupEl = (g, gi) => {
    const gname = el("input", { class: "cat-group-name", value: g.name });
    gname.oninput = () => { g.name = gname.value; markDirty(); };
    const color = el("input", { type: "color", class: "group-color", value: g.color || "#9aa0ad", title: "Group color (used on the Summary)" });
    color.oninput = () => { g.color = color.value; gEl.style.setProperty("--gc", g.color); gEl.classList.add("colored"); noColor.hidden = false; markDirty(); };
    const noColor = el("button", { class: "icon", title: "No color", hidden: !g.color }, "No color");
    noColor.onclick = () => { delete g.color; drawCategoryEditor(); };
    const addCat = el("button", {}, "+ Category");
    addCat.onclick = () => { g.categories.push({ id: uniqueId("new_category", allIds()), name: "New category" }); drawCategoryEditor(); };
    const brk = el("button", { class: `icon break-toggle${g.sectionBreak ? " on" : ""}`, title: "Leave a bigger gap before this group on the Summary", disabled: gi === 0 }, "Section break");
    brk.onclick = () => { if (g.sectionBreak) delete g.sectionBreak; else g.sectionBreak = true; drawCategoryEditor(); };
    const delGroup = el("button", { class: "icon", title: g.categories.length ? "Move or delete its categories first" : "Delete group", disabled: g.categories.length > 0 }, "✕");
    delGroup.onclick = () => { draft.groups.splice(draft.groups.indexOf(g), 1); drawCategoryEditor(); };

    const list = el("div", { class: "cat-list" }, g.categories.map((c, ci) => {
      const name = el("input", { value: c.name, size: 26 });
      name.oninput = () => {
        c.name = name.value;
        // brand-new categories take their id from the first real name
        if (!cats.groups.some((x) => x.categories.some((y) => y.id === c.id)) && name.value.trim()) c.id = uniqueId(name.value, allIds().filter((id) => id !== c.id));
        markDirty();
      };
      const n = used[c.id] || 0;
      const del = el("button", { class: "icon", title: n ? `Used by ${n} transactions. Recategorize them first.` : "Delete category", disabled: n > 0 }, "✕");
      del.onclick = () => { g.categories.splice(ci, 1); drawCategoryEditor(); };
      // Archive: from the chosen month on, the category is grayed out on the Summary and no longer offered
      let archive;
      if (c.archivedFrom) {
        const month = el("input", { type: "month", class: "archive-month", value: c.archivedFrom, title: "First month it's archived", "aria-label": `${c.name} archived from` });
        month.onchange = () => { if (month.value) { c.archivedFrom = month.value; markDirty(); } else month.value = c.archivedFrom; };
        const un = el("button", { class: "icon", title: "Bring it back for every month" }, "Unarchive");
        un.onclick = () => { delete c.archivedFrom; drawCategoryEditor(); };
        archive = el("span", { class: "archive-ctl" }, el("span", { class: "muted" }, "Archived from"), month, un);
      } else {
        archive = el("button", { class: "icon", title: "Retire this category from a month you pick (earlier months keep it)" }, "Archive…");
        archive.onclick = () => { c.archivedFrom = new Date().toISOString().slice(0, 7); drawCategoryEditor(); };
      }
      const row = el("div", { class: `row cat-row${c.archivedFrom ? " archived-cat" : ""}` });
      row.append(dragHandle(row, "cat"), name, el("span", { class: "muted", style: "min-width:60px" }, n ? `${n} used` : ""), archive, del);
      catOf.set(row, c);
      return row;
    }));
    if (!g.categories.length) list.append(el("div", { class: "muted cat-empty" }, "Drag categories here"));

    const gEl = el("div", { class: `cat-group${g.sectionBreak && gi > 0 ? " section-start" : ""}${g.color ? " colored" : ""}`, style: g.color ? `--gc: ${g.color}` : null });
    gEl.append(el("div", { class: "row" }, dragHandle(gEl, "group"), color, gname, addCat, brk, delGroup, noColor), list);
    groupOf.set(gEl, g);
    // a category dragged anywhere over a group (even an empty one) lands in that group's list
    gEl.addEventListener("dragover", (e) => { if (drag?.kind === "cat") { list.querySelector(".cat-empty")?.remove(); dropInto(list, ".cat-row", e); } });
    return gEl;
  };

  const groupsEl = el("div", { class: "cat-groups" }, draft.groups.map(groupEl));
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
    el("div", { class: "muted", style: "margin:4px 0 8px" }, "Drag ☰ to reorder groups and categories, or to move a category into another group. This order is used in the summary and the dropdowns. Renaming keeps existing transactions linked. \"Section break\" leaves a bigger gap before this group on the Summary. \"Archive…\" retires a category from a month you pick: earlier years still show it, later months are grayed out, and anything still in it then shows red."),
    el("div", { class: "row", style: "margin-bottom:10px" }, actions()),
    groupsEl,
    el("div", { class: "row", style: "margin-top:10px" }, addGroup),
    el("div", { class: "row", style: "margin-top:12px" }, actions()),
  ));
}

// ---------- settings tab ----------
function renderSettings() {
  renderConnection();
  renderAiSettings();
  renderYearSettings();
  renderAccounts();
  renderBackup();
}

function renderYearSettings() {
  const box = $("yearPanel");
  box.innerHTML = "";
  const sel = el("select", { id: "sFyStart" }, MONTHS.map((m, i) => el("option", { value: String(i + 1) }, m)));
  sel.value = String(fyStart());
  const example = el("div", { class: "muted", style: "margin-top:6px" });
  const showExample = () => {
    const cur = fyLabel(new Date().toISOString().slice(0, 10));
    example.textContent = fyStart() === 1 ? `Calendar years: this year is ${cur}.` : `This year is ${cur}: ${fyRangeText(cur, fyStart())}. A year is named by the year it ends in.`;
  };
  sel.onchange = () => {
    budget = rebaseBudget(budget, +sel.value); // predicted single months stay in their calendar month
    queueOp({ type: "budget", doc: budget });
    $("sumYear").value = "";
    fillYearSelect();
    fillDateFilter();
    showExample();
  };
  showExample();
  box.append(
    el("h2", { style: "margin-top:0" }, "Financial year"),
    el("div", { class: "muted" }, "The Summary and Predict views run over a financial year, and the transaction date filter offers whole financial years. Saved in your data repo."),
    el("div", { class: "settings-grid" }, el("div", {}, el("label", { for: "sFyStart" }, "Starts in"), sel)),
    example,
  );
}

function renderBackup() {
  const box = $("backupPanel");
  box.innerHTML = "";
  const btn = el("button", { id: "exportBackup", class: "primary" }, "Export all data");
  const msg = el("div", { class: "status" });
  const show = (text, cls) => { msg.className = `status ${cls}`; msg.textContent = text; };
  box.append(
    el("h2", { style: "margin-top:0" }, "Backup"),
    el("div", { class: "muted" }, "Downloads a .zip with every file in your data repo (accounts, transactions, categories, AI notes...) plus what only this browser keeps: the AI log, any unsaved edits, and the connection settings. Your token and API key are never included. The zip's README explains how to restore it into a new private repo."),
    el("div", { class: "row", style: "margin-top:10px" }, btn), msg,
  );
  btn.onclick = async () => {
    btn.disabled = true;
    show("Saving pending edits and reading the data repo…", "muted");
    try {
      const r = await call("exportBackup");
      const url = URL.createObjectURL(new Blob([r.bytes], { type: "application/zip" }));
      const a = el("a", { href: url, download: r.filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      show(`Downloaded ${r.filename}: ${r.files} data files at commit ${r.commit.slice(0, 7)}.` +
        (r.saveError ? ` ⚠ Some edits couldn't be saved to GitHub (${r.saveError}); they're in browser/unsaved-edits.json.` : ""), r.saveError ? "bad" : "good");
    } catch (e) { show(e.message, "bad"); }
    btn.disabled = false;
  };
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

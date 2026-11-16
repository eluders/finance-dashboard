// Web dashboard (served by GitHub Pages). Reads/writes the private data repo directly with the
// token saved in Settings. The shared data code lives in ../extension/src/lib/.
import { fmtMoney, fmtDate, el, accountBadge, accountColor } from "../extension/src/lib/ui.js";
import { resolveSplits, parseMoneyInput } from "../extension/src/lib/splits.js";
import { categoryIndex, uniqueId, validateCategories } from "../extension/src/lib/categories.js";
import { applyState, editableState } from "../extension/src/lib/edits.js";
import { onStorageChanged } from "../extension/src/lib/platform.js";
import { OUTBOX_KEY, pendingCount } from "./lib/outbox.js";
import { call } from "./lib/backend.js";

const $ = (id) => document.getElementById(id);
let accounts = [], txns = [], cats = { version: 2, groups: [] }, catIdx = new Map(), catOptionsHtml = "";
const expanded = new Set();
const rowEls = new Map(); // txn id -> <tr>
const byId = () => Object.fromEntries(accounts.map((a) => [a.id, a]));
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

$("reload").onclick = load;
$("filterAccount").onchange = render;
$("search").oninput = render;
$("toggleAccounts").onclick = () => { $("accountPanel").hidden = !$("accountPanel").hidden; renderAccounts(); };
$("toggleSettings").onclick = () => { $("settingsPanel").hidden = !$("settingsPanel").hidden; if (!$("settingsPanel").hidden) openSettings(); };
$("toggleCategories").onclick = () => { $("categoryPanel").hidden = !$("categoryPanel").hidden; if (!$("categoryPanel").hidden) openCategoryEditor(); };
load();

function setStatus(msg, cls = "") { $("status").className = `status ${cls}`; $("status").textContent = msg; }

// ---------- loading ----------
async function load() {
  setStatus("Loading from GitHub…", "muted");
  let st;
  try {
    st = await call("getStatus");
    if (!st.configured) { accounts = []; txns = []; }
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
  if (!st.configured) { setStatus("Not connected to your data repo yet. Fill in Settings.", "warn"); if ($("settingsPanel").hidden) { $("settingsPanel").hidden = false; openSettings(); } }
  else if (!st.initialized) setStatus(`${st.repo} has no data yet. Save a page from the extension to set it up.`, "warn");
  else if (!st.importCount) setStatus("No imports yet. In the extension, on a bank page: Extract → Compare with saved → Save.", "warn");
  else setStatus("");

  const sel = $("filterAccount");
  const keep = sel.value;
  sel.length = 1;
  for (const a of accounts) sel.append(el("option", { value: a.id }, `${a.name}  …${a.last4 || "?"}`));
  sel.value = accounts.some((a) => a.id === keep) ? keep : "";
  render();
  if (!$("accountPanel").hidden) renderAccounts();
}

function setCategories(doc) {
  cats = doc;
  catIdx = categoryIndex(doc);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  catOptionsHtml = `<option value="">Uncategorized</option>` + doc.groups.map((g) =>
    `<optgroup label="${esc(g.name)}">${g.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</optgroup>`).join("");
}

function catSelect(value, cls = "cell-select") {
  const s = document.createElement("select");
  s.className = cls;
  s.innerHTML = catOptionsHtml;
  if (value && !catIdx.has(value)) s.append(new Option(`(deleted: ${value})`, value));
  s.value = value || "";
  s.classList.toggle("uncat", !s.value); // faint text = still to do
  return s;
}

// ---------- editing: instant locally, buffered in the outbox, flushed to GitHub by the background ----------
let outboxState = null; // last known outbox (kept fresh via storage.onChanged)
const FLUSH_MS = 60_000; // must match lib/outbox.js default

/** Applies an edit to the in-memory transaction now and queues its final state for GitHub. */
function commitEdit(t, changes) {
  applyState(t, { ...editableState(t), ...changes }); // throws on an invalid split (UI prevents that)
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
  if (o?.flushing) { el_.className = "muted"; el_.textContent = `Saving ${n} change${n === 1 ? "" : "s"} to GitHub…`; }
  else if (n && o.lastFlush && !o.lastFlush.ok && o.lastFlush.at >= (o.since || 0)) {
    el_.className = "bad"; el_.textContent = `Save failed (${o.lastFlush.error}). Your changes are kept locally; retrying in ${mmss(o.lastFlush.at + FLUSH_MS - Date.now())}`;
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

// ---------- table ----------
function render() {
  const acct = $("filterAccount").value;
  const q = $("search").value.toLowerCase();
  const rows = txns.filter((t) => (!acct || t.accountId === acct)
    && (!q || t.description.toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q) || (t.merchant || "").toLowerCase().includes(q)));
  $("count").textContent = `${rows.length} transactions`;
  const accts = byId();
  rowEls.clear();
  const body = el("tbody");
  for (const t of rows.slice(0, 2000)) {
    const tr = rowFor(t, accts);
    rowEls.set(t.id, tr);
    body.append(tr);
    if (expanded.has(t.id)) body.append(detailRow(t));
  }
  $("txns").innerHTML = "";
  $("txns").append(el("table", { class: "dense" },
    el("colgroup", {},
      el("col", { style: "width:74px" }),   // account badge
      el("col", { style: "width:96px" }),   // MM-DD-YYYY
      el("col", { style: "width:25%" }),    // bank description
      el("col", { style: "width:105px" }),  // amount
      el("col"),                            // your note
      el("col", { style: "width:210px" })), // category
    el("thead", {}, el("tr", {}, el("th", {}, "Account"), el("th", {}, "Date"), el("th", {}, "Description"), el("th", { class: "num" }, "Amount"), el("th", {}, "Note"), el("th", {}, "Category"))),
    body,
  ));
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
    catCell.onchange = () => { catCell.classList.toggle("uncat", !catCell.value); commitEdit(t, { category: catCell.value || null }); };
  }

  const tr = el("tr", { class: `tx${expanded.has(t.id) ? " open" : ""}` },
    el("td", {}, accountBadge(accts[t.accountId] || { id: t.accountId, name: t.accountId })),
    el("td", {}, fmtDate(t.date)),
    el("td", { title: t.description }, t.description),
    el("td", { class: `num ${t.amountCents > 0 ? "good" : ""}` }, fmtMoney(t.amountCents)),
    el("td", { class: "edit" }, note),
    el("td", { class: "edit" }, catCell),
  );
  tr.onclick = (e) => { if (!e.target.closest("input, select, button")) toggle(t); };
  return tr;
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
  return el("tr", { class: "detail" }, el("td", { colspan: 6 },
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
      el("div", { style: "flex:1.4" }, splitEditor(t)),
    ),
  ));
}

// ---------- split editor ----------
function splitEditor(t) {
  const sign = t.amountCents < 0 ? -1 : 1;
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
      cat.onchange = () => { r.category = cat.value; };
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
      const r = resolveSplits(t.amountCents, toSplits());
      for (const s of r.splits) if (s.remainder) {
        const cell = remCells.get(s.id);
        if (cell) { cell.textContent = Number.isFinite(s.amountCents) ? (Math.abs(s.amountCents) / 100).toFixed(2) : "—"; cell.classList.toggle("bad", !r.ok); }
      }
      const incomplete = rows.some((x) => !x.remainder && parseMoneyInput(x.amount) == null);
      summary.className = `split-summary ${r.ok ? "good" : incomplete ? "muted" : "bad"}`;
      summary.textContent = r.ok
        ? `Adds up to ${fmtMoney(t.amountCents)} ✓`
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
      el("div", { style: "margin-bottom:4px" }, el("b", {}, `Split ${fmtMoney(t.amountCents)}`), t.splitsNeedReview ? el("span", { class: "warn" }, "  ⚠ amount changed when this posted; check the rows") : ""),
      el("table", { class: "split-table" }, body),
      summary,
      el("div", { class: "row", style: "margin-top:6px" }, add, save, cancel, remove),
    );
    totals();
  }
  draw();
  return wrap;
}

// ---------- category editor ----------
let draft = null;

function openCategoryEditor() {
  draft = structuredClone(cats);
  drawCategoryEditor();
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
  const groupEls = [...$("categoryPanel").querySelectorAll(".cat-groups > .cat-group")];
  draft.groups = groupEls.map((gEl) => {
    const g = groupOf.get(gEl);
    g.categories = [...gEl.querySelectorAll(".cat-row")].map((r) => catOf.get(r));
    return g;
  });
  drawCategoryEditor();
}

function drawCategoryEditor() {
  const box = $("categoryPanel");
  box.innerHTML = "";
  const used = usageCounts();
  const allIds = () => draft.groups.flatMap((g) => g.categories.map((c) => c.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(cats);
  const markDirty = () => { $("catDirty").textContent = JSON.stringify(draft) !== JSON.stringify(cats) ? "Unsaved changes" : ""; };

  const groupsEl = el("div", { class: "cat-groups" }, draft.groups.map((g, gi) => {
    const gname = el("input", { class: "cat-group-name", value: g.name });
    gname.oninput = () => { g.name = gname.value; markDirty(); };
    const addCat = el("button", {}, "+ Category");
    addCat.onclick = () => { g.categories.push({ id: uniqueId("new_category", allIds()), name: "New category" }); drawCategoryEditor(); };
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

    const groupEl = el("div", { class: "cat-group" });
    groupEl.append(el("div", { class: "row" }, dragHandle(groupEl, "group"), gname, addCat, delGroup), list);
    groupOf.set(groupEl, g);
    // a category dragged anywhere over a group (even an empty one) lands in that group's list
    groupEl.addEventListener("dragover", (e) => { if (drag?.kind === "cat") { list.querySelector(".cat-empty")?.remove(); dropInto(list, ".cat-row", e); } });
    return groupEl;
  }));
  groupsEl.addEventListener("dragover", (e) => { if (drag?.kind === "group") dropInto(groupsEl, ".cat-group", e); });

  const addGroup = el("button", {}, "+ Group");
  addGroup.onclick = () => { draft.groups.push({ id: uniqueId("group", draft.groups.map((g) => g.id)), name: "New group", categories: [] }); drawCategoryEditor(); };
  const save = el("button", { class: "primary" }, "Apply categories");
  save.onclick = () => {
    try { validateCategories(draft); } catch (e) { setStatus(e.message, "bad"); return; }
    const doc = structuredClone(draft);
    setCategories(doc);
    queueOp({ type: "categories", doc });
    render();
    drawCategoryEditor();
    $("catDirty").textContent = "Applied ✓";
  };
  const discard = el("button", {}, "Discard changes");
  discard.onclick = openCategoryEditor;

  box.append(
    el("div", { class: "row", style: "justify-content:space-between" }, el("h2", { style: "margin:0" }, "Categories"), el("span", { id: "catDirty", class: "warn" }, dirty ? "Unsaved changes" : "")),
    el("div", { class: "muted", style: "margin:4px 0 8px" }, "Drag ☰ to reorder groups and categories, or to move a category into another group. Order here is the order in the dropdowns. Renaming keeps existing transactions linked."),
    groupsEl,
    el("div", { class: "row", style: "margin-top:10px" }, addGroup, save, discard),
  );
}

// ---------- settings (connection to the data repo; stored only in this browser) ----------
async function openSettings() {
  const box = $("settingsPanel");
  const c = await call("getConnection");
  box.innerHTML = "";
  const field = (id, label, attrs = {}) => el("div", {}, el("label", { for: id }, label), el("input", { id, ...attrs }));
  box.append(
    el("h2", { style: "margin-top:0" }, "Settings"),
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

// ---------- accounts ----------
function renderAccounts() {
  const box = $("accountPanel");
  if (box.hidden) return;
  box.innerHTML = "";
  if (!accounts.length) { box.append(el("div", { class: "muted" }, "No accounts yet.")); return; }
  const counts = {};
  for (const t of txns) counts[t.accountId] = (counts[t.accountId] || 0) + 1;
  box.append(el("h2", { style: "margin-top:0" }, "Accounts"), el("table", {},
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

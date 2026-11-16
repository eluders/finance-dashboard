// Excel-style multi-select on the Category column of the transaction table.
//   click            opens that row's category dropdown (and selects the cell)
//   drag             selects a range of rows (start on a category cell, move up/down)
//   shift-click      extends the range from the last clicked cell
//   ctrl/cmd-click   adds or removes one cell
//   Ctrl+C / Ctrl+V  copies the clicked cell's category / pastes it into every selected cell
//   Delete           sets the selected cells to Uncategorized
//   Ctrl+Z           undoes the last bulk change;  Esc clears the selection
// A bar at the bottom shows the count and offers the same actions with the mouse. Split transactions
// are skipped (their categories live on the split parts).
import { el } from "../extension/src/lib/ui.js";

let ctx = null;
let sel = new Set();  // selected transaction ids
let anchor = null;    // last clicked id (for shift-click)
let drag = null;      // { start, moved, td }
let clip = null;      // { category, name }
let undo = null;      // { items: [{ t, before }], label }
let note = "";        // short feedback shown in the bar

export const isSelected = (id) => sel.has(id);

/**
 * ctx: { rows() → displayed transactions in order, isActive() → bool, setCategory(t, category),
 *        catName(id), catOptionsHtml() }
 */
export function initCellSelect(c) {
  ctx = c;
  const root = document.getElementById("txns");
  root.addEventListener("mousedown", onDown);
  root.addEventListener("mouseover", onOver);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("mousemove", autoscroll);
  document.addEventListener("keydown", onKey);
  // clicking anywhere else (not the table's category cells or the bar) clears the selection
  document.addEventListener("mousedown", (e) => {
    if (!sel.size || e.target.closest?.("#txns td.cat-cell, #selBar")) return;
    clear();
  });
}

const idOf = (node) => node?.closest("tr.tx")?.dataset.id || null;

function onDown(e) {
  const td = e.target.closest("td.cat-cell");
  if (!td || e.button !== 0 || !ctx.isActive()) return;
  const id = idOf(td);
  if (!id) return;
  e.preventDefault(); // keep the native dropdown closed for now: this may become a drag
  // a previously clicked dropdown must not keep focus (arrow keys would silently change that row)
  if (document.activeElement?.matches?.("select, input")) document.activeElement.blur();
  note = "";
  if (e.shiftKey && anchor) { selectRange(anchor, id, e.ctrlKey || e.metaKey); return; }
  if (e.ctrlKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); anchor = id; render(); return; }
  sel = new Set([id]);
  anchor = id;
  drag = { start: id, moved: false, td };
  render();
}

function onOver(e) {
  if (!drag) return;
  const id = idOf(e.target);
  if (!id) return;
  if (id !== drag.start) drag.moved = true;
  if (drag.moved) selectRange(drag.start, id);
}

function onUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.moved) return;
  // a plain click: behave like a normal dropdown
  const s = d.td.querySelector("select");
  if (s) { s.focus(); try { s.showPicker?.(); } catch (_) { /* not allowed here: the focused select still works by keyboard */ } }
  // (a split pill is a button: its own click handler still runs)
}

function autoscroll(e) {
  if (!drag) return;
  if (e.clientY > window.innerHeight - 40) window.scrollBy(0, 18);
  else if (e.clientY < 110) window.scrollBy(0, -18);
}

function selectRange(a, b, add = false) {
  const order = ctx.rows().map((t) => t.id);
  let i = order.indexOf(a), j = order.indexOf(b);
  if (i < 0 || j < 0) return;
  if (i > j) [i, j] = [j, i];
  const range = order.slice(i, j + 1);
  sel = add ? new Set([...sel, ...range]) : new Set(range);
  render();
}

function onKey(e) {
  if (!ctx.isActive() || !sel.size) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.type !== "checkbox"))) return; // typing a note
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "c") { e.preventDefault(); copy(); }
  else if (mod && k === "v") { e.preventDefault(); paste(); }
  else if (mod && k === "z" && undo) { e.preventDefault(); doUndo(); }
  else if (e.key === "Delete" || (e.key === "Backspace" && sel.size > 1)) { e.preventDefault(); assign(null); }
  else if (e.key === "Escape") clear();
}

const selectedTxns = () => ctx.rows().filter((t) => sel.has(t.id));

export function copy() {
  const src = ctx.rows().find((t) => t.id === anchor && sel.has(t.id)) || selectedTxns()[0];
  if (!src) return;
  if (src.splits?.length) { note = "A split transaction has no single category to copy."; render(); return; }
  clip = { category: src.category || null, name: ctx.catName(src.category || null) };
  navigator.clipboard?.writeText?.(clip.name).catch(() => {}); // handy for pasting into a spreadsheet
  note = `Copied "${clip.name}"`;
  render();
}

export function paste() {
  if (!clip) { note = "Copy a category first (click a cell, Ctrl+C)."; render(); return; }
  assign(clip.category);
}

/** Sets every selected (non-split) transaction to `category`, remembering the old values for Undo. */
export function assign(category) {
  const items = [];
  let splits = 0;
  for (const t of selectedTxns()) {
    if (t.splits?.length) { splits++; continue; }
    if ((t.category || null) === category) continue;
    items.push({ t, before: t.category || null });
    ctx.setCategory(t, category);
  }
  const name = ctx.catName(category);
  undo = items.length ? { items, label: `Set ${items.length} to ${name}` } : undo;
  note = `${items.length ? `Set ${items.length} to ${name}` : "Nothing to change"}${splits ? ` · ${splits} split skipped` : ""}`;
  render();
}

function doUndo() {
  const u = undo;
  undo = null;
  for (const { t, before } of u.items) ctx.setCategory(t, before);
  note = `Undid: ${u.label}`;
  render();
}

export function clear() {
  sel = new Set();
  anchor = null;
  note = "";
  render();
}

/** Re-applies highlight classes (after any re-render) and draws the bar. */
export function render() {
  if (!ctx) return;
  const shown = new Set(ctx.rows().map((t) => t.id));
  for (const id of [...sel]) if (!shown.has(id)) sel.delete(id); // filtered out
  for (const tr of document.querySelectorAll("#txns tr.tx")) tr.querySelector("td.cat-cell")?.classList.toggle("selected", sel.has(tr.dataset.id));
  drawBar();
}

function drawBar() {
  let bar = document.getElementById("selBar");
  if (!bar) { bar = el("div", { id: "selBar", class: "sel-bar" }); document.body.append(bar); }
  const active = ctx.isActive() && (sel.size || undo);
  bar.hidden = !active;
  if (!active) return;
  bar.innerHTML = "";
  const set = document.createElement("select");
  set.innerHTML = `<option value="__none" disabled selected>Set category…</option>${ctx.catOptionsHtml()}`;
  set.onchange = () => assign(set.value || null);
  const btn = (text, on, attrs = {}) => Object.assign(el("button", attrs, text), { onclick: on });
  bar.append(...[
    el("b", {}, `${sel.size} selected`),
    sel.size ? set : null,
    sel.size ? btn("Copy", copy, { title: "Ctrl+C: copy the clicked cell's category" }) : null,
    sel.size ? btn(clip ? `Paste "${clip.name}"` : "Paste", paste, { title: "Ctrl+V", disabled: !clip }) : null,
    undo ? btn("Undo", doUndo, { title: `Ctrl+Z: ${undo.label}` }) : null,
    note ? el("span", { class: "sel-note" }, note) : el("span", { class: "muted small" }, "Drag to select · Shift/Ctrl-click · Ctrl+C / Ctrl+V · Del clears"),
    btn("✕", () => { undo = null; clear(); }, { class: "icon", title: "Clear selection (Esc)" }),
  ].filter(Boolean));
}

// Excel-style multi-select on the Category column of the transaction table. No toolbars or
// prompts: everything happens in place.
//   click the dropdown   opens it (and selects that cell)
//   click the blank strip / drag   selects; drag up or down to select a range
//   shift-click          extends the range from the last clicked cell
//   ctrl/cmd-click       adds or removes one cell
//   Ctrl+C               copies the clicked cell's category (it gets a dashed outline)
//   Ctrl+V               pastes it into every selected cell, instantly (cells flash)
//   Delete               sets the selected cells to Uncategorized
//   Ctrl+Z               undoes the last paste/delete;   Esc clears the selection and the copy
// Split transactions are skipped (their categories live on the split parts).

let ctx = null;
let sel = new Set();  // selected transaction ids
let anchor = null;    // last clicked id (for shift-click)
let drag = null;      // { start, moved, td, onSelect }
let clip = null;      // { id, category } of the copied cell
let undo = null;      // [{ t, before }] of the last bulk change

export const isSelected = (id) => sel.has(id);
export const isCopied = (id) => clip?.id === id;

/** ctx: { rows() → displayed transactions in order, isActive() → bool, setCategories([{ t, category }]) } */
export function initCellSelect(c) {
  ctx = c;
  const root = document.getElementById("txns");
  root.addEventListener("mousedown", onDown);
  root.addEventListener("mouseover", onOver);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("mousemove", autoscroll);
  document.addEventListener("keydown", onKey);
  // clicking anywhere else clears the selection (the copied cell stays copied, like Excel)
  document.addEventListener("mousedown", (e) => {
    if (!sel.size || e.target.closest?.("#txns td.cat-cell")) return;
    sel = new Set(); anchor = null; render();
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
  if (e.shiftKey && anchor) { selectRange(anchor, id, e.ctrlKey || e.metaKey); return; }
  if (e.ctrlKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); anchor = id; render(); return; }
  sel = new Set([id]);
  anchor = id;
  drag = { start: id, moved: false, td, onControl: !!e.target.closest("select, button") };
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
  if (d.moved || !d.onControl) return; // a drag, or a click on the blank strip: just select
  // a plain click on the dropdown: behave like a normal dropdown
  const s = d.td.querySelector("select");
  if (s) { s.focus(); try { s.showPicker?.(); } catch (_) { /* the focused select still works by keyboard */ } }
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
  if (!ctx.isActive()) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.type !== "checkbox"))) return; // typing a note
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") { sel = new Set(); clip = null; render(); return; }
  if (mod && k === "z" && undo) { e.preventDefault(); doUndo(); return; }
  if (!sel.size) return;
  if (mod && k === "c") { e.preventDefault(); copy(); }
  else if (mod && k === "v") { e.preventDefault(); if (clip) assign(clip.category); }
  else if (e.key === "Delete" || (e.key === "Backspace" && sel.size > 1)) { e.preventDefault(); assign(null); }
}

const selectedTxns = () => ctx.rows().filter((t) => sel.has(t.id));

function copy() {
  const src = ctx.rows().find((t) => t.id === anchor && sel.has(t.id)) || selectedTxns()[0];
  if (!src || src.splits?.length) return;
  clip = { id: src.id, category: src.category || null };
  render();
}

/** Sets every selected (non-split) transaction to `category` in one batch, remembering old values for Undo. */
function assign(category) {
  const items = selectedTxns().filter((t) => !t.splits?.length && (t.category || null) !== category);
  if (!items.length) return;
  undo = items.map((t) => ({ t, before: t.category || null }));
  ctx.setCategories(items.map((t) => ({ t, category })));
  render();
  flash(items.map((t) => t.id));
}

function doUndo() {
  const u = undo;
  undo = null;
  ctx.setCategories(u.map(({ t, before }) => ({ t, category: before })));
  render();
  flash(u.map(({ t }) => t.id));
}

/** Brief highlight on cells that just changed. */
function flash(ids) {
  const set = new Set(ids);
  for (const tr of document.querySelectorAll("#txns tr.tx")) {
    if (!set.has(tr.dataset.id)) continue;
    const td = tr.querySelector("td.cat-cell");
    td?.classList.remove("flash"); void td?.offsetWidth; td?.classList.add("flash");
  }
}

/** Re-applies highlight classes (after any re-render). */
export function render() {
  if (!ctx) return;
  const shown = new Set(ctx.rows().map((t) => t.id));
  for (const id of [...sel]) if (!shown.has(id)) sel.delete(id); // filtered out
  for (const tr of document.querySelectorAll("#txns tr.tx")) {
    const td = tr.querySelector("td.cat-cell");
    td?.classList.toggle("selected", sel.has(tr.dataset.id));
    td?.classList.toggle("copied", clip?.id === tr.dataset.id);
  }
}

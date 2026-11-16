// Checkbox category picker: groups with tri-state group boxes, All / None, and a per-row "only".
// `set` holds category ids plus the specials UNCAT ("__uncat") and ARCHIVE_ID; it's mutated in place.
import { el } from "../extension/src/lib/ui.js";
import { ARCHIVE_ID } from "../extension/src/lib/categories.js";

export const UNCAT = "__uncat";

export function pickerIds(cats, { uncat = true, archive = true } = {}) {
  return [...(uncat ? [UNCAT] : []), ...(archive ? [ARCHIVE_ID] : []), ...cats.groups.flatMap((g) => g.categories.map((c) => c.id))];
}

export function describeSelection(set, cats, opts) {
  const all = pickerIds(cats, opts);
  const n = all.filter((i) => set.has(i)).length;
  if (n === all.length) return "all";
  if (!n) return "none";
  if (opts?.archive !== false && !set.has(ARCHIVE_ID) && n === all.length - 1) return "all but Archive";
  const name = (i) => (i === UNCAT ? "Uncategorized" : i === ARCHIVE_ID ? "Archive" : cats.groups.flatMap((g) => g.categories).find((c) => c.id === i)?.name || i);
  const picked = all.filter((i) => set.has(i));
  return picked.slice(0, 2).map(name).join(", ") + (picked.length > 2 ? ` +${picked.length - 2}` : "");
}

/**
 * @param {{ label: string, set: Set<string>, cats: object, uncat?: boolean, archive?: boolean, popover?: boolean, onChange: (set) => void, id?: string }} o
 */
export function catPicker({ label, set, cats, uncat = true, archive = true, popover = false, onChange, id }) {
  const opts = { uncat, archive };
  const box = el("details", { class: `cat-picker${popover ? " popover" : ""}`, ...(id ? { id } : {}) });
  const summary = el("summary");
  const boxes = new Map(); // id -> checkbox
  const groupBoxes = [];
  const refresh = () => {
    summary.textContent = `${label}: ${describeSelection(set, cats, opts)}`;
    for (const [i, cb] of boxes) cb.checked = set.has(i);
    for (const { cb, ids } of groupBoxes) { const n = ids.filter((i) => set.has(i)).length; cb.checked = n === ids.length && n > 0; cb.indeterminate = n > 0 && n < ids.length; }
  };
  const changed = () => { refresh(); onChange?.(set); };
  const setAll = (ids, on) => { for (const i of ids) { if (on) set.add(i); else set.delete(i); } changed(); };

  const item = (i, text, cls = "") => {
    const cb = el("input", { type: "checkbox", "data-id": i });
    cb.onchange = () => setAll([i], cb.checked);
    boxes.set(i, cb);
    const only = el("button", { class: "only", type: "button", title: `Only ${text}` }, "only");
    only.onclick = (e) => { e.preventDefault(); set.clear(); set.add(i); changed(); };
    return el("div", { class: `cb-row ${cls}` }, el("label", { class: "cb" }, cb, text), only);
  };

  const body = el("div", { class: "cat-picker-body" },
    el("div", { class: "row" },
      Object.assign(el("button", { class: "icon", type: "button" }, "All"), { onclick: () => setAll(pickerIds(cats, opts), true) }),
      Object.assign(el("button", { class: "icon", type: "button" }, "None"), { onclick: () => setAll(pickerIds(cats, opts), false) }),
      archive ? Object.assign(el("button", { class: "icon", type: "button" }, "All but Archive"), { onclick: () => { setAll(pickerIds(cats, opts), true); setAll([ARCHIVE_ID], false); } }) : null),
    el("div", { class: "cat-picker-special" }, uncat ? item(UNCAT, "Uncategorized") : null, archive ? item(ARCHIVE_ID, "Archive") : null),
    el("div", { class: "cat-picker-groups" }, cats.groups.map((g) => {
      const ids = g.categories.map((c) => c.id);
      const gcb = el("input", { type: "checkbox" });
      gcb.onchange = () => setAll(ids, gcb.checked);
      groupBoxes.push({ cb: gcb, ids });
      return el("div", { class: "cat-picker-group" }, el("label", { class: "cb group" }, gcb, g.name), el("div", {}, g.categories.map((c) => item(c.id, c.archivedFrom ? `${c.name} (archived)` : c.name, c.archivedFrom ? "archived-cat" : ""))));
    })));
  box.append(summary, body);
  if (popover) document.addEventListener("click", (e) => { if (box.open && !box.contains(e.target)) box.open = false; });
  refresh();
  return box;
}

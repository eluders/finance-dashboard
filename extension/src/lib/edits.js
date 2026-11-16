// User-editable state of a transaction, applied identically in the dashboard (instantly, locally)
// and in the store (when the outbox is flushed to GitHub).
//
// Edits are recorded as the *final state* of the editable fields, not as patches, so any sequence
// of edits (categorize → split → unsplit …) collapses to one entry with an unambiguous result.
import { resolveSplits } from "./splits.js";

export const EDITABLE_FIELDS = ["note", "category", "splits"];

export function editableState(t) {
  return { note: t.note || "", category: t.category || null, splits: t.splits?.length ? t.splits.map((s) => ({ ...s })) : [] };
}

/**
 * Sets t's editable fields to `state`. Returns { correction } when the category changed to a real value
 * (the categorizer's training signal). With lenient=true (server side), a split that no longer adds up
 * because the bank amount changed meanwhile is kept and flagged instead of rejected.
 */
export function applyState(t, state, now = new Date().toISOString(), { lenient = false } = {}) {
  const note = String(state.note || "").trim();
  if (note) t.note = note; else delete t.note;

  let category = state.category || null;
  if (state.splits?.length) {
    const r = resolveSplits(t.amountCents, state.splits);
    if (!r.ok && !lenient) throw new Error(r.error);
    t.splits = r.splits.map(({ id, amountCents, category: c, note: n, remainder }) => ({
      id, amountCents, category: c || null, ...(n?.trim() ? { note: n.trim() } : {}), ...(remainder ? { remainder: true } : {}),
    }));
    if (r.ok) delete t.splitsNeedReview; else t.splitsNeedReview = true;
    category = null; // the splits carry the categories
  } else {
    delete t.splits;
    delete t.splitsNeedReview;
  }

  let correction = null;
  if (category !== (t.category || null)) {
    if (category) correction = { from: t.category || null, fromSource: t.categorySource || null, to: category };
    t.category = category;
    t.categorySource = category ? "user" : null;
  }
  t.updatedAt = now;
  return { correction };
}

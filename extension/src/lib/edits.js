// User-editable state of a transaction, applied identically in the dashboard (instantly, locally)
// and in the store (when the outbox is flushed to GitHub).
//
// Edits are recorded as the *final state* of the editable fields, not as patches, so any sequence
// of edits (categorize → split → unsplit …) collapses to one entry with an unambiguous result.
import { resolveSplits } from "./splits.js";

export const EDITABLE_FIELDS = ["note", "category", "splits", "overrideCents"];

/**
 * The amount that counts in summaries: the user's override (e.g. 0 for something reimbursed) or
 * the bank amount. The bank amount itself is never changed, so dedupe/matching keep working.
 */
export const trackedCents = (t) => (Number.isInteger(t.overrideCents) ? t.overrideCents : t.amountCents);

export function editableState(t) {
  return {
    note: t.note || "", category: t.category || null, splits: t.splits?.length ? t.splits.map((s) => ({ ...s })) : [],
    overrideCents: Number.isInteger(t.overrideCents) ? t.overrideCents : null,
  };
}

/**
 * Sets t's editable fields to `state`. Returns { correction } when the category changed to a real value
 * (the categorizer's training signal). With lenient=true (server side), a split that no longer adds up
 * because the bank amount changed meanwhile is kept and flagged instead of rejected.
 */
export function applyState(t, state, now = new Date().toISOString(), { lenient = false } = {}) {
  const note = String(state.note || "").trim();
  if (note) t.note = note; else delete t.note;

  if ("overrideCents" in state) {
    const o = state.overrideCents;
    if (o == null) delete t.overrideCents;
    else if (!Number.isInteger(o)) throw new Error("The counted amount must be a whole number of cents.");
    else if (o !== 0 && Math.sign(o) !== Math.sign(t.amountCents)) throw new Error("The counted amount must go the same direction as the transaction.");
    else if (o === t.amountCents) delete t.overrideCents; // same as the bank amount: no override
    else t.overrideCents = o;
  }

  let category = state.category || null;
  if (state.splits?.length) {
    if (trackedCents(t) === 0) throw new Error("A transaction counted as $0 can't be split. Clear the counted amount first.");
    const r = resolveSplits(trackedCents(t), state.splits);
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

// Split-transaction math, shared by the dashboard (live preview) and the store (validation on save).
//
// A split is { id, amountCents, category, note, remainder? }. Amounts are signed the same way as the
// parent transaction. At most one split may be the "remainder": its amount is always
// parent total minus the other splits, so the user never has to make it add up by hand.

/**
 * @returns {{ ok, splits, unassignedCents, error }}
 *   splits: copies with the remainder's amount filled in
 *   unassignedCents: total minus sum of splits (0 when ok)
 */
export function resolveSplits(totalCents, splits) {
  const list = (splits || []).map((s) => ({ ...s }));
  const rem = list.filter((s) => s.remainder);
  if (rem.length > 1) return fail(list, totalCents, "Only one row can take the remaining balance.");
  const sign = Math.sign(totalCents) || 1;

  let sumOthers = 0;
  for (const s of list) {
    if (s.remainder) continue;
    if (!Number.isInteger(s.amountCents) || s.amountCents === 0) return fail(list, totalCents, "Every row needs an amount (or mark one as the remaining balance).");
    if (Math.sign(s.amountCents) !== sign) return fail(list, totalCents, "Split amounts must go the same direction as the transaction.");
    sumOthers += s.amountCents;
  }
  if (rem.length) {
    rem[0].amountCents = totalCents - sumOthers;
    if (rem[0].amountCents !== 0 && Math.sign(rem[0].amountCents) !== sign) return fail(list, totalCents, "The other rows add up to more than the transaction.");
    return { ok: true, splits: list, unassignedCents: 0, error: null };
  }
  const unassigned = totalCents - sumOthers;
  if (unassigned !== 0) return { ok: false, splits: list, unassignedCents: unassigned, error: "Rows don't add up to the transaction total. Adjust them or mark one as the remaining balance." };
  return { ok: true, splits: list, unassignedCents: 0, error: null };
}

function fail(splits, total, error) {
  const assigned = splits.reduce((s, x) => s + (Number.isInteger(x.amountCents) && !x.remainder ? x.amountCents : 0), 0);
  return { ok: false, splits, unassignedCents: total - assigned, error };
}

/** "12.5" / "$1,234.56" -> cents (positive), or null. */
export function parseMoneyInput(str) {
  const s = String(str ?? "").replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  return parseInt(w || "0", 10) * 100 + parseInt((f + "00").slice(0, 2), 10);
}

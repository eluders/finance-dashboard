// Compares freshly extracted transactions against what is already stored.
// If both sides carry a bank reference id it decides. Otherwise the match key is (date, amount) as a multiset: two identical $5.00 coffees on the
// same day stay two transactions. Secondary pass links pending -> posted changes.

const DAY = 86400000;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const key = (t) => `${t.date}|${t.amountCents}`;
// "TRADER JOE S #068" (pending) vs "TRADER JOE S #068 SANTA ROSA CA" (posted) -> "TRADERJOES"
const merchantKey = (d) => {
  const k = String(d || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return k.length >= 4 ? k : null;
};

/**
 * @param existing stored transactions for the account
 * @param incoming extracted transactions (already sign-normalized)
 * @param opts.pendingWindowDays how far a posted txn may drift from its pending date
 * @returns {{ add, duplicates, updates, stalePending }}
 *   add:          incoming txns with no match (to insert)
 *   duplicates:   [{incoming, existing}] exact (date, amount) matches (skip)
 *   updates:      [{incoming, existing}] stored pending txn now seen as posted / re-dated (patch)
 *   stalePending: stored pending txns inside the page's date range that no longer appear (offer removal)
 */
export function reconcile(existing, incoming, { pendingWindowDays = 5 } = {}) {
  const byKey = new Map();
  for (const t of existing) {
    if (!byKey.has(key(t))) byKey.set(key(t), []);
    byKey.get(key(t)).push(t);
  }
  const consumed = new Set();
  const take = (list, pred = () => true) => {
    if (!list) return null;
    // prefer matching status, then any
    const hit = list.find((t) => !consumed.has(t.id) && pred(t)) || null;
    if (hit) consumed.add(hit.id);
    return hit;
  };

  const duplicates = [], updates = [], unmatched = [];
  // pass 0: bank reference ids (WF cards give each posted txn a unique ref) are authoritative
  const byRef = new Map(existing.filter((t) => t.bankRef).map((t) => [t.bankRef, t]));
  const remaining = [];
  for (const inc of incoming) {
    const hit = inc.bankRef && byRef.get(inc.bankRef);
    if (hit && !consumed.has(hit.id)) {
      consumed.add(hit.id);
      (hit.date !== inc.date || hit.amountCents !== inc.amountCents || hit.status !== inc.status ? updates : duplicates).push({ incoming: inc, existing: hit });
    } else remaining.push(inc);
  }

  // pass 1: exact (date, amount); same-status first so pending/posted pairs line up.
  // Two records that both carry *different* bank refs are different transactions.
  const refOk = (inc) => (t) => !(inc.bankRef && t.bankRef && inc.bankRef !== t.bankRef);
  for (const inc of remaining) {
    const list = byKey.get(key(inc));
    const ok = refOk(inc);
    const hit = take(list, (t) => ok(t) && t.status === inc.status) || take(list, ok);
    if (!hit) { unmatched.push(inc); continue; }
    if (hit.status === "pending" && inc.status === "posted") updates.push({ incoming: inc, existing: hit });
    else duplicates.push({ incoming: inc, existing: hit });
  }

  // pass 2: a stored pending txn whose posted version has the same amount but a later date
  const pendings = existing.filter((t) => t.status === "pending");
  const near = (p, inc) => !consumed.has(p.id) && refOk(inc)(p) && Math.abs(dayDiff(p.date, inc.date)) <= pendingWindowDays;
  const stillUnmatched = [];
  for (const inc of unmatched) {
    const hit = pendings.find((p) => near(p, inc) && p.amountCents === inc.amountCents);
    if (hit) { consumed.add(hit.id); updates.push({ incoming: inc, existing: hit }); }
    else stillUnmatched.push(inc);
  }

  // pass 3: pending posted at a different amount (restaurant tip, gas pre-auth): same merchant
  // prefix, same direction, amount within -20%..+35%. Linking (instead of add + delete) keeps the
  // user's note/category/splits on the transaction.
  const add = [];
  for (const inc of stillUnmatched) {
    const key = merchantKey(inc.description);
    const hit = inc.status === "posted" && key && pendings.find((p) => near(p, inc)
      && merchantKey(p.description) === key
      && Math.sign(p.amountCents) === Math.sign(inc.amountCents)
      && Math.abs(inc.amountCents) >= Math.abs(p.amountCents) * 0.8
      && Math.abs(inc.amountCents) <= Math.abs(p.amountCents) * 1.35);
    if (hit) { consumed.add(hit.id); updates.push({ incoming: inc, existing: hit }); }
    else add.push(inc);
  }

  // pending txns that vanished (voided, or posted with a different amount e.g. tip added)
  // (pending dates precede their posted dates, so widen the page's range by the drift window)
  const minIncoming = incoming.reduce((m, t) => (t.date < m ? t.date : m), "9999-12-31");
  const minDate = new Date(Date.parse(minIncoming) - pendingWindowDays * DAY).toISOString().slice(0, 10);
  const stalePending = pendings.filter((p) => !consumed.has(p.id) && p.date >= minDate);

  return { add, duplicates, updates, stalePending };
}

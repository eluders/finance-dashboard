# Data repo layout

The extension writes to a **separate private GitHub repo** (e.g. `finance-data`). Every import is one atomic commit, so `git log` in that repo is a full audit trail and any bad import can be reverted.

```
accounts.json                     { accounts: [Account] }
transactions/<accountId>/<YYYY>.json   { accountId, year, transactions: [Transaction] }  (newest first)
balances.json                     { snapshots: [{accountId, date, balanceCents, source}] }   → net worth
imports.json                      { imports: [{id, accountId, at, added, updated, removed, duplicates, extractorId, url, ...}] }
categories.json                   v2: { version: 2, groups: [{id, name, side?: "maximize", sectionBreak?, categories: [{id, name}]}] }  (side absent = minimize)  (array order = display order; sectionBreak starts a new block with its own subtotal in the summary; v1 flat lists migrate on read)
rules.json                        { rules: [...] }          deterministic merchant → category rules (learned)
corrections.json                  { corrections: [...] }    user overrides of AI categories (training signal)
ai-notes.md                       categorizer's self-maintained notes
budget.json                       { version: 1, years: { "YYYY": { <categoryId>: { monthly: cents } | { months: [cents|null ×12] } } } }  predicted amounts (positive cents); avg = monthly, or sum(months)/12
```

Planned: `holdings/<accountId>.json` (positions snapshots), `investment-transactions/…`, `targets.json` (allocation targets for DCA).

## Account
```json
{ "id": "wellsfargo-checking-1234", "institution": "wellsfargo", "type": "checking|savings|credit_card|brokerage|ira_roth|401k|hsa|529",
  "name": "Everyday Checking", "last4": "1234", "createdAt": "…" }
```

## Transaction
```json
{
  "id": "16 hex chars",
  "accountId": "wellsfargo-checking-1234",
  "date": "YYYY-MM-DD",            // transaction date (cards) / posted date (checking)
  "postedDate": "YYYY-MM-DD|null", // cards only
  "bankRef": "string|null",        // bank's unique reference id when the page shows one (WF cards)
  "amountCents": -1299,            // integer cents; negative = money out of the account
  "description": "raw text from the bank",
  "merchant": "cleaned merchant guess or null",
  "status": "posted|pending",
  "category": null,                // category id (null when split; the splits carry categories)
  "categorySource": null,          // "rule" | "ai" | "user"
  "note": "optional, user-written",
  "overrideCents": 0,              // optional "counted amount": what summaries count instead of amountCents
                                   // (0 = reimbursed / not tracked). amountCents stays the bank amount for matching.
  "splits": [                      // optional; signed like the parent; sum to the counted amount (override or bank amount)
    { "id": "…", "amountCents": -1250, "category": "health", "note": "pharmacy" },
    { "id": "…", "amountCents": -6750, "category": "groceries", "remainder": true }  // at most one; = total − others
  ],
  "splitsNeedReview": true,        // set if a pending→posted amount change broke a split with no remainder row
  "source": "wellsfargo",          // extractor id
  "importId": "imp_…", "importedAt": "…", "updatedAt": "…"
}
```

**Sign convention:** always from the account's point of view. Card purchase = negative, card payment received = positive. Checking deposit = positive.

## Dedupe rules (src/lib/reconcile.js)
0. If both records have a `bankRef`, it decides: same ref is the same transaction (date and amount updated if they changed); different refs are always different transactions.
1. Exact `(date, amountCents)` match → already saved (multiset — two identical same-day charges stay two).
2. Stored *pending* with same amount within ±5 days of an incoming *posted* → update the stored record.
3. Stored *pending* with the same merchant prefix and an amount within −20%..+35% (tips, gas pre-auths) → update, which keeps the user's note, category and splits. Splits re-balance through their remainder row.
4. Stored *pending* inside the page's date range that no longer appears → offered for removal (voided, or posted at a different amount, e.g. a tip).

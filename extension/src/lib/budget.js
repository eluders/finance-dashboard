// Predicted amounts per category per month (budget.json in the data repo).
//   { version: 1, years: { "2026": { "<categoryId>": { monthly: 12000 } | { months: [cents|null × 12] } } } }
// Amounts are positive cents in the summary's sense: spending for minimize categories, the size of
// the flow for maximize ones (income, giving, investing).
// `monthly` fills every month and locks them. Without it, individual months are entered and the
// average is their sum over 12, so a one-off (a trip in June) spreads across the year.
export const BUDGET_FILE = "budget.json";
export const emptyBudget = () => ({ version: 1, years: {} });

export function normalizeBudget(doc) {
  return doc?.version === 1 && doc.years && typeof doc.years === "object" ? doc : emptyBudget();
}

const isCents = (v) => Number.isInteger(v) && v >= 0;

export function validateBudget(doc) {
  if (doc?.version !== 1 || !doc.years || typeof doc.years !== "object") throw new Error("Bad budget document.");
  for (const [year, cats] of Object.entries(doc.years)) {
    if (!/^\d{4}$/.test(year)) throw new Error(`Bad budget year "${year}".`);
    for (const [id, e] of Object.entries(cats)) {
      if (e.monthly != null) { if (!isCents(e.monthly)) throw new Error(`Bad monthly amount for ${id} in ${year}.`); }
      else if (!Array.isArray(e.months) || e.months.length !== 12 || !e.months.every((v) => v == null || isCents(v)))
        throw new Error(`Bad months for ${id} in ${year}.`);
    }
  }
  return doc;
}

export const budgetEntry = (doc, year, id) => doc?.years?.[year]?.[id] || null;

/** The 12 predicted values (null = nothing entered). */
export function entryMonths(e) {
  if (!e) return Array(12).fill(null);
  if (e.monthly != null) return Array(12).fill(e.monthly);
  return e.months.map((v) => (v == null ? null : v));
}

/** Predicted average per month in cents, or null if nothing is predicted. */
export function entryAvg(e) {
  if (!e) return null;
  if (e.monthly != null) return e.monthly;
  const vals = e.months.filter((v) => v != null);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / 12) : null;
}

/** Returns a new doc with the entry for (year, id) replaced; an empty entry is removed. */
export function setEntry(doc, year, id, entry) {
  const next = structuredClone(normalizeBudget(doc));
  const yr = (next.years[year] ||= {});
  const empty = !entry || (entry.monthly == null && !(entry.months || []).some((v) => v != null));
  if (empty) delete yr[id];
  else yr[id] = entry.monthly != null ? { monthly: entry.monthly } : { months: entry.months.map((v) => (v == null ? null : v)) };
  if (!Object.keys(yr).length) delete next.years[year];
  return next;
}

/** Sets (or clears, with null) the locked monthly amount. Clearing keeps the filled months, now editable. */
export function setMonthly(doc, year, id, cents) {
  const e = budgetEntry(doc, year, id);
  if (cents == null) return setEntry(doc, year, id, e?.monthly != null ? { months: Array(12).fill(e.monthly) } : e);
  return setEntry(doc, year, id, { monthly: cents });
}

/** Sets one month (0-11). Ignored while a monthly amount locks the months. */
export function setMonth(doc, year, id, m, cents) {
  const e = budgetEntry(doc, year, id);
  if (e?.monthly != null) return doc;
  const months = e ? [...e.months] : Array(12).fill(null);
  months[m] = cents;
  return setEntry(doc, year, id, { months });
}

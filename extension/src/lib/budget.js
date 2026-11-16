// Predicted amounts per category per month (budget.json in the data repo).
//   { version: 1, years: { "2026": { "<categoryId>": { monthly: 12000 } | { months: [cents|null × 12] } } } }
// Amounts are positive cents in the summary's sense: spending for minimize categories, the size of
// the flow for maximize ones (income, giving, investing).
// `monthly` fills every month and locks them. Without it, individual months are entered and the
// average is their sum over 12, so a one-off (a trip in June) spreads across the year.
//
// Years are FINANCIAL years. `fyStart` (1-12) is the month a financial year starts; a year is named by
// the calendar year it ENDS in (fyStart 11: "2027" = Nov 2026 - Oct 2027). `months` is in financial
// order: index 0 is the first month of the financial year.
export const BUDGET_FILE = "budget.json";
export const DEFAULT_FY_START = 11; // November
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const emptyBudget = () => ({ version: 1, fyStart: DEFAULT_FY_START, years: {} });

// ---------- financial years ----------
/** Financial-year label ("2027") for a "YYYY-MM[-DD]" date. */
export function fyOf(date, start) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  return String(start > 1 && m >= start ? y + 1 : y);
}
/** Position (0-11) of a date's month inside its financial year. */
export const fyPos = (date, start) => (+date.slice(5, 7) - start + 12) % 12;
/** "YYYY-MM" of position `pos` in financial year `label`. */
export function fyMonth(label, pos, start) {
  const m = ((start - 1 + pos) % 12) + 1;
  const y = start > 1 && m >= start ? +label - 1 : +label;
  return `${y}-${String(m).padStart(2, "0")}`;
}
/** Month names in financial order. */
export const fyMonthNames = (start) => MONTH_NAMES.map((_, i) => MONTH_NAMES[(start - 1 + i) % 12]);
/** "Nov 2026 – Oct 2027" */
export function fyRangeText(label, start) {
  const a = fyMonth(label, 0, start), b = fyMonth(label, 11, start);
  return `${MONTH_NAMES[+a.slice(5) - 1]} ${a.slice(0, 4)} – ${MONTH_NAMES[+b.slice(5) - 1]} ${b.slice(0, 4)}`;
}

/**
 * Re-files predictions for a new financial-year start. Single months keep their calendar month
 * (a June trip stays in June); a Monthly amount stays on its year's label.
 */
export function rebaseBudget(doc, newStart) {
  const old = doc.fyStart || 1;
  if (old === newStart) return { ...doc, fyStart: newStart };
  const next = { version: 1, fyStart: newStart, years: {} };
  const entries = Object.entries(doc.years || {}).flatMap(([label, cats]) => Object.entries(cats).map(([id, e]) => ({ label, id, e })));
  for (const { label, id, e } of entries) if (e.monthly != null) (next.years[label] ||= {})[id] = { monthly: e.monthly };
  for (const { label, id, e } of entries) {
    if (e.monthly != null) continue;
    e.months.forEach((v, pos) => {
      if (v == null) return;
      const ym = fyMonth(label, pos, old);
      const yr = (next.years[fyOf(ym, newStart)] ||= {});
      const target = (yr[id] ||= { months: Array(12).fill(null) });
      if (target.months) target.months[fyPos(ym, newStart)] = v;
    });
  }
  return next;
}

export function normalizeBudget(doc) {
  if (!(doc?.version === 1 && doc.years && typeof doc.years === "object")) return emptyBudget();
  // written before financial years existed: those were calendar years
  return doc.fyStart ? doc : rebaseBudget({ ...doc, fyStart: 1 }, DEFAULT_FY_START);
}

const isCents = (v) => Number.isInteger(v) && v >= 0;

export function validateBudget(doc) {
  if (doc?.version !== 1 || !doc.years || typeof doc.years !== "object") throw new Error("Bad budget document.");
  if (doc.fyStart != null && !(Number.isInteger(doc.fyStart) && doc.fyStart >= 1 && doc.fyStart <= 12)) throw new Error("Bad financial-year start month.");
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

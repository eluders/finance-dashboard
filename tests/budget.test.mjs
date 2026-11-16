import { test } from "node:test";
import assert from "node:assert/strict";
import { fyOf, fyPos, fyMonth, fyRangeText, fyMonthNames, normalizeBudget, rebaseBudget, entryAvg, setMonthly, setMonth, budgetEntry } from "../extension/src/lib/budget.js";

test("financial years are named by the year they end in", () => {
  assert.equal(fyOf("2026-11-01", 11), "2027");
  assert.equal(fyOf("2026-10-31", 11), "2026");
  assert.equal(fyOf("2026-05-01", 1), "2026");
  assert.equal(fyPos("2026-11-03", 11), 0);
  assert.equal(fyPos("2027-10-03", 11), 11);
  assert.equal(fyMonth("2027", 0, 11), "2026-11");
  assert.equal(fyMonth("2027", 2, 11), "2027-01");
  assert.equal(fyRangeText("2027", 11), "Nov 2026 – Oct 2027");
  assert.deepEqual(fyMonthNames(11).slice(0, 3), ["Nov", "Dec", "Jan"]);
});

test("budgets saved before financial years (calendar) move to the Nov-Oct year, keeping calendar months", () => {
  const v1 = { version: 1, years: { "2026": { trip: { months: [null, null, null, null, null, 250000, null, null, null, null, null, 500] }, rent: { monthly: 100 } } } };
  const b = normalizeBudget(v1);
  assert.equal(b.fyStart, 11);
  assert.equal(b.years["2026"].trip.months[7], 250000, "June 2026 is in FY2026 (Nov 2025 - Oct 2026)");
  assert.equal(b.years["2027"].trip.months[1], 500, "Dec 2026 is in FY2027");
  assert.deepEqual(b.years["2026"].rent, { monthly: 100 });
  assert.deepEqual(rebaseBudget(rebaseBudget(b, 1), 11), b, "round trip");
});

test("monthly locks the year; single months average over 12", () => {
  let b = normalizeBudget(null);
  b = setMonth(b, "2027", "x", 3, 120000);
  assert.equal(entryAvg(budgetEntry(b, "2027", "x")), 10000);
  b = setMonthly(b, "2027", "x", 5000);
  assert.equal(setMonth(b, "2027", "x", 1, 1), b, "locked");
  b = setMonthly(b, "2027", "x", null);
  assert.deepEqual(budgetEntry(b, "2027", "x").months, Array(12).fill(5000), "clearing keeps the filled months");
});

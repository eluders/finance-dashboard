import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../extension/src/lib/reconcile.js";

const tx = (id, date, amountCents, status = "posted") => ({ id, date, amountCents, status, description: id });

test("exact duplicates are skipped, new ones added", () => {
  const existing = [tx("a", "2026-11-01", -500), tx("b", "2026-11-02", -1299)];
  const incoming = [tx("x", "2026-11-01", -500), tx("y", "2026-11-02", -1299), tx("z", "2026-11-03", -4200)];
  const r = reconcile(existing, incoming);
  assert.equal(r.duplicates.length, 2);
  assert.deepEqual(r.add.map((t) => t.id), ["z"]);
});

test("same-day identical charges are a multiset, not collapsed", () => {
  const existing = [tx("a", "2026-11-01", -500)];
  const incoming = [tx("x", "2026-11-01", -500), tx("y", "2026-11-01", -500)];
  const r = reconcile(existing, incoming);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.add.length, 1);
});

test("pending becomes posted on a later date", () => {
  const existing = [tx("p", "2026-11-10", -2500, "pending")];
  const incoming = [tx("x", "2026-11-12", -2500, "posted")];
  const r = reconcile(existing, incoming);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].existing.id, "p");
  assert.equal(r.add.length, 0);
});

test("pending posted same day is an update, not a duplicate", () => {
  const r = reconcile([tx("p", "2026-11-10", -2500, "pending")], [tx("x", "2026-11-10", -2500, "posted")]);
  assert.equal(r.updates.length, 1);
  assert.equal(r.duplicates.length, 0);
});

test("pending with changed amount (tip) is stale; posted one is new", () => {
  const existing = [tx("p", "2026-11-10", -4000, "pending")];
  const incoming = [tx("x", "2026-11-11", -4800, "posted")];
  const r = reconcile(existing, incoming);
  assert.equal(r.add.length, 1);
  assert.deepEqual(r.stalePending.map((t) => t.id), ["p"]);
});

test("same date+amount but different bank refs are different transactions", () => {
  const existing = [{ ...tx("a", "2026-11-08", -1249), bankRef: "REF1" }];
  const incoming = [{ ...tx("x", "2026-11-08", -1249), bankRef: "REF1" }, { ...tx("y", "2026-11-08", -1249), bankRef: "REF2" }];
  const r = reconcile(existing, incoming);
  assert.equal(r.duplicates.length, 1);
  assert.deepEqual(r.add.map((t) => t.id), ["y"]);
});

test("bank ref match wins even if the date shifted", () => {
  const existing = [{ ...tx("a", "2026-11-08", -1249), bankRef: "REF1" }];
  const r = reconcile(existing, [{ ...tx("x", "2026-11-09", -1249), bankRef: "REF1" }]);
  assert.equal(r.updates.length, 1);
  assert.equal(r.add.length, 0);
});

test("pending card charge (no ref) links to its posted version (with ref)", () => {
  const existing = [tx("p", "2026-11-14", -4200, "pending")];
  const r = reconcile(existing, [{ ...tx("x", "2026-11-14", -4200, "posted"), bankRef: "REF9" }]);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].existing.id, "p");
});

test("pending that posts with a tip links to the posted version (keeps user edits)", () => {
  const existing = [{ ...tx("p", "2026-11-10", -4000, "pending"), description: "TST*FLOUR & WATER" }];
  const incoming = [{ ...tx("x", "2026-11-11", -4800, "posted"), description: "TST*FLOUR & WATER - SAN San FranciscoCA" }];
  const r = reconcile(existing, incoming);
  assert.equal(r.updates.length, 1);
  assert.equal(r.add.length, 0);
  assert.equal(r.stalePending.length, 0);
});

test("different merchant or a wildly different amount is not linked", () => {
  const existing = [{ ...tx("p", "2026-11-10", -4000, "pending"), description: "TRADER JOE S #068" }];
  assert.equal(reconcile(existing, [{ ...tx("x", "2026-11-11", -4800), description: "SAFEWAY #1439" }]).updates.length, 0);
  assert.equal(reconcile(existing, [{ ...tx("x", "2026-11-11", -9000), description: "TRADER JOE S #068 SANTA ROSA" }]).updates.length, 0);
});

test("old pending outside the page's date range is not flagged stale", () => {
  const existing = [tx("p", "2026-09-01", -4000, "pending")];
  const incoming = [tx("x", "2026-11-11", -100)];
  assert.equal(reconcile(existing, incoming).stalePending.length, 0);
});

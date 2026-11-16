import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runExtractor } from "./helpers/run-extractor.mjs";

const WF_URL = "https://connect.secure.wellsfargo.com/accounts/inquiry/summary/home/default";
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("WF checking: columns give sign, pending section, account + balance", () => {
  const r = runExtractor(fixture("wf-checking.html"), WF_URL);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.extractorId, "wellsfargo");
  assert.equal(r.method, "wellsfargo-table");
  assert.deepEqual(r.account, { name: "Everyday Checking", last4: "4321", type: "checking" });
  assert.equal(r.balanceCents, 125000);
  assert.equal(r.balanceLabel, "Available balance");
  const t = r.transactions.map(({ date, amountCents, status, description }) => ({ date, amountCents, status, description }));
  assert.deepEqual(t, [
    { date: "2026-11-14", amountCents: -650, status: "pending", description: "PURCHASE AUTHORIZED ON 11/13 BLUE BOTTLE COFFEE S000000000000000 CARD 4321" },
    { date: "2026-11-13", amountCents: 200000, status: "posted", description: "ACME CORP PAYROLL 000000 JANE DOE" },
    { date: "2026-11-04", amountCents: -120000, status: "posted", description: "CHECK # 101" },
  ]);
  assert.equal(r.transactions[0].merchantGuess, "BLUE BOTTLE COFFEE");
  assert.equal(r.hasMorePages, true);
  assert.deepEqual(r.warnings, []);
});

test("WF card: charges negative, '+' credits positive, pending region, bank refs", () => {
  const r = runExtractor(fixture("wf-card.html"), WF_URL);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.account, { name: "WELLS FARGO ACTIVE CASH VISA CARD", last4: "8765", type: "credit_card" });
  assert.equal(r.balanceCents, -43210, "outstanding card balance is a liability");
  const t = r.transactions.map(({ date, postedDate, amountCents, status, bankRef }) => ({ date, postedDate, amountCents, status, bankRef }));
  assert.deepEqual(t, [
    { date: "2026-11-14", postedDate: null, amountCents: -4200, status: "pending", bankRef: null },
    { date: "2026-11-12", postedDate: "2026-11-13", amountCents: -123456, status: "posted", bankRef: "1111111AAAAAAAAA1" },
    { date: "2026-11-10", postedDate: "2026-11-10", amountCents: 50000, status: "posted", bankRef: "2222222BBBBBBBBB2" },
  ]);
  assert.equal(r.transactions[1].merchantGuess, "BIG BOX STORE CA");
  assert.equal(r.hasMorePages, false);
});

test("non-WF pages use the generic extractor", () => {
  const html = `<table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
    <tbody><tr><td>11/01/2026</td><td>Coffee</td><td>-$4.50</td></tr></tbody></table>`;
  const r = runExtractor(html, "https://bank.example.com/activity");
  assert.equal(r.extractorId, "generic");
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].amountCents, -450);
});

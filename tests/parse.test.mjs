import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

vm.runInThisContext(fs.readFileSync(new URL("../extension/src/content/common.js", import.meta.url), "utf8"));
const FD = globalThis.FD;

test("parseAmountCents", () => {
  assert.equal(FD.parseAmountCents("$1,234.56"), 123456);
  assert.equal(FD.parseAmountCents("-$5.00"), -500);
  assert.equal(FD.parseAmountCents("−$5.00"), -500);
  assert.equal(FD.parseAmountCents("($12.30)"), -1230);
  assert.equal(FD.parseAmountCents("$7.5"), 750);
  assert.equal(FD.parseAmountCents("$20"), 2000);
  assert.equal(FD.parseAmountCents("45.00-"), -4500);
  assert.equal(FD.parseAmountCents(""), null);
  assert.equal(FD.parseAmountCents("abc"), null);
});

test("parseDate", () => {
  const ref = new Date(2026, 10, 14); // Nov 14 2026
  assert.equal(FD.parseDate("11/14/2026", ref), "2026-11-14");
  assert.equal(FD.parseDate("1/3/26", ref), "2026-01-03");
  assert.equal(FD.parseDate("2026-11-02", ref), "2026-11-02");
  assert.equal(FD.parseDate("Nov 3, 2026", ref), "2026-11-03");
  assert.equal(FD.parseDate("Sept 9, 2026", ref), "2026-09-09");
  assert.equal(FD.parseDate("Oct 30", ref), "2026-10-30");
  assert.equal(FD.parseDate("12/28", new Date(2026, 0, 5)), "2025-12-28");
  assert.equal(FD.parseDate("13/40/2026", ref), null);
});

test("findLast4", () => {
  assert.equal(FD.findLast4("Everyday Checking ...1234"), "1234");
  assert.equal(FD.findLast4("Active Cash Card ending in 9876"), "9876");
  assert.equal(FD.findLast4("no number"), null);
});

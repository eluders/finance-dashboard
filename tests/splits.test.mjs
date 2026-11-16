import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSplits, parseMoneyInput } from "../extension/src/lib/splits.js";
import { normalizeCategories, categoryIndex, uniqueId } from "../extension/src/lib/categories.js";

test("remainder row absorbs whatever is left", () => {
  const r = resolveSplits(-8000, [{ id: "a", amountCents: -1250, category: "health" }, { id: "b", remainder: true, category: "groceries" }]);
  assert.equal(r.ok, true);
  assert.equal(r.splits[1].amountCents, -6750);
  assert.equal(r.unassignedCents, 0);
});

test("without a remainder row the rows must add up exactly", () => {
  const r = resolveSplits(-8000, [{ id: "a", amountCents: -1250 }, { id: "b", amountCents: -6000 }]);
  assert.equal(r.ok, false);
  assert.equal(r.unassignedCents, -750);
  assert.equal(resolveSplits(-8000, [{ id: "a", amountCents: -2000 }, { id: "b", amountCents: -6000 }]).ok, true);
});

test("rejects two remainder rows, overshoot, wrong direction, empty rows", () => {
  assert.match(resolveSplits(-100, [{ remainder: true }, { remainder: true }]).error, /Only one/);
  assert.match(resolveSplits(-1000, [{ amountCents: -1500 }, { remainder: true }]).error, /more than/);
  assert.match(resolveSplits(-1000, [{ amountCents: 500 }, { remainder: true }]).error, /direction/);
  assert.match(resolveSplits(-1000, [{ amountCents: null }, { remainder: true }]).error, /needs an amount/);
});

test("remainder recomputes when the parent amount changes (pending tip)", () => {
  const splits = [{ id: "a", amountCents: -1000 }, { id: "b", remainder: true }];
  assert.equal(resolveSplits(-4000, splits).splits[1].amountCents, -3000);
  assert.equal(resolveSplits(-4800, splits).splits[1].amountCents, -3800);
});

test("parseMoneyInput", () => {
  assert.equal(parseMoneyInput("12.5"), 1250);
  assert.equal(parseMoneyInput("$1,234.56"), 123456);
  assert.equal(parseMoneyInput(".99"), 99);
  assert.equal(parseMoneyInput("abc"), null);
  assert.equal(parseMoneyInput(""), null);
});

test("v1 flat categories migrate to ordered groups", () => {
  const v2 = normalizeCategories({ version: 1, categories: [
    { id: "groceries", name: "Groceries", group: "Food" },
    { id: "rent", name: "Rent", group: "Housing" },
    { id: "dining", name: "Dining", group: "Food" },
  ] });
  assert.deepEqual(v2.groups.map((g) => [g.name, g.categories.map((c) => c.id)]), [["Food", ["groceries", "dining"]], ["Housing", ["rent"]]]);
  assert.equal(categoryIndex(v2).get("dining").groupName, "Food");
  assert.equal(uniqueId("Food & Drink", ["food_drink"]), "food_drink_2");
});

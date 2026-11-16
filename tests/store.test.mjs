import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub } from "./helpers/fake-github.mjs";

let gh;
const settings = { ghOwner: "me", ghRepo: "finance-data", ghBranch: "main", ghToken: "t" };
globalThis.chrome = { storage: { local: { get: async () => ({ settings }) } } };
const store = await import("../extension/src/lib/store.js");
const { reconcile } = await import("../extension/src/lib/reconcile.js");

beforeEach(() => {
  gh = fakeGitHub();
  globalThis.fetch = gh.fetch;
});

const acct = { id: "wellsfargo-checking-4321", institution: "wellsfargo", type: "checking", name: "Everyday Checking", last4: "4321" };
const extracted = [
  { date: "2026-11-13", amountCents: 200000, description: "PAYROLL", status: "posted" },
  { date: "2026-11-04", amountCents: -120000, description: "CHECK # 101", status: "posted" },
  { date: "2025-12-30", amountCents: -500, description: "COFFEE", status: "posted" },
];
const planFor = (add, extra = {}) => ({ accountId: acct.id, add, updates: [], removeIds: [], meta: { extractorId: "wellsfargo" }, ...extra });

test("empty repo: status says uninitialized and reads return nothing (no throw)", async () => {
  const st = await store.getStatus();
  assert.equal(st.initialized, false);
  assert.deepEqual(await store.listAccounts(), []);
  assert.deepEqual(await store.getAllTransactions(), []);
});

test("first save into an EMPTY repo initializes it and lands account + transactions in one go", async () => {
  const r = await store.commitImport(planFor(extracted, { newAccount: acct, balanceCents: 125000 }));
  assert.ok(r.sha);
  const files = gh.files();
  for (const f of ["README.md", "accounts.json", "categories.json", "imports.json", "balances.json", "ai-notes.md"]) assert.ok(files.has(f), `missing ${f}`);
  assert.ok(files.has("transactions/wellsfargo-checking-4321/2026.json"));
  assert.ok(files.has("transactions/wellsfargo-checking-4321/2025.json"), "split by year");

  assert.deepEqual((await store.listAccounts()).map((a) => a.id), [acct.id]);
  const all = await store.getAllTransactions();
  assert.equal(all.length, 3);
  assert.equal(all[0].date, "2026-11-13", "newest first");
  const st = await store.getStatus();
  assert.equal(st.initialized, true);
  assert.equal(st.importCount, 1);
  assert.equal(JSON.parse(files.get("balances.json")).snapshots[0].balanceCents, 125000);
});

test("re-extracting the same page adds nothing; the pending→posted update is applied", async () => {
  await store.commitImport(planFor([...extracted, { date: "2026-11-14", amountCents: -650, description: "BLUE BOTTLE", status: "pending" }], { newAccount: acct }));
  const existing = await store.getTransactions(acct.id, ["2025", "2026"]);
  const again = [...extracted, { date: "2026-11-15", amountCents: -650, description: "BLUE BOTTLE", status: "posted" }];
  const r = reconcile(existing, again);
  assert.equal(r.add.length, 0);
  assert.equal(r.duplicates.length, 3);
  assert.equal(r.updates.length, 1);
  await store.commitImport(planFor([], { updates: r.updates.map((u) => ({ existingId: u.existing.id, incoming: u.incoming })) }));
  const after = await store.getAllTransactions();
  assert.equal(after.length, 4);
  const coffee = after.find((t) => t.description === "BLUE BOTTLE");
  assert.equal(coffee.status, "posted");
  assert.equal(coffee.date, "2026-11-15");
});

test("blocks saving a page into an account with a different last 4", async () => {
  await store.commitImport(planFor(extracted, { newAccount: acct, detectedLast4: "4321" }));
  const before = gh.log().length;
  const cardPage = [{ date: "2026-11-14", amountCents: -4200, description: "CARD CHARGE", status: "posted" }];
  await assert.rejects(store.commitImport(planFor(cardPage, { detectedLast4: "8765" })), /Blocked: the page shows account …8765/);
  assert.equal(gh.log().length, before, "no commit was made");
  assert.equal((await store.getAllTransactions()).length, 3);
});

test("edit note + category (logged as correction), then split with a remainder row", async () => {
  await store.commitImport(planFor(extracted, { newAccount: acct }));
  const t = (await store.getAllTransactions()).find((x) => x.description === "CHECK # 101");
  const edit = (patch) => store.updateTransaction({ accountId: acct.id, id: t.id, date: t.date, patch });

  let s = await edit({ note: "  rent to landlord  ", category: "housing" });
  assert.equal(s.note, "rent to landlord");
  assert.equal(s.category, "housing");
  assert.equal(s.categorySource, "user");
  assert.equal(JSON.parse(gh.files().get("corrections.json")).corrections.at(-1).to, "housing");

  s = await edit({ splits: [{ id: "a", amountCents: -20000, category: "utilities" }, { id: "b", remainder: true, category: "housing" }] });
  assert.equal(s.splits[1].amountCents, -100000);
  assert.equal(s.category, null, "parent category cleared once split");

  await assert.rejects(edit({ splits: [{ id: "a", amountCents: -20000 }, { id: "b", amountCents: -1 }] }), /don't add up/);
  await assert.rejects(edit({ amountCents: 5 }), /can't be edited/);

  s = await edit({ splits: [] });
  assert.equal(s.splits, undefined);
});

test("splits re-balance when a pending amount changes on import", async () => {
  await store.commitImport(planFor([{ date: "2026-11-10", amountCents: -4000, description: "TST*FLOUR & WATER", status: "pending" }], { newAccount: acct }));
  const [p] = await store.getAllTransactions();
  await store.updateTransaction({ accountId: acct.id, id: p.id, date: p.date, patch: { splits: [{ id: "a", amountCents: -1000, category: "gifts" }, { id: "b", remainder: true, category: "dining" }] } });
  const posted = { date: "2026-11-11", amountCents: -4800, description: "TST*FLOUR & WATER - SAN", status: "posted" };
  await store.commitImport(planFor([], { updates: [{ existingId: p.id, incoming: posted }] }));
  const [after] = await store.getAllTransactions();
  assert.equal(after.amountCents, -4800);
  assert.deepEqual(after.splits.map((x) => x.amountCents), [-1000, -3800]);
});

test("categories save round-trips and rejects duplicates", async () => {
  const doc = await store.getCategories();
  assert.equal(doc.version, 2);
  doc.groups.reverse();
  await store.saveCategories(doc);
  assert.deepEqual((await store.getCategories()).groups.map((g) => g.id), doc.groups.map((g) => g.id));
  doc.groups[0].categories.push({ id: doc.groups[1].categories[0].id, name: "dupe" });
  await assert.rejects(store.saveCategories(doc), /Duplicate/);
});

test("applyEdits: many edits + categories in ONE commit; missing txn reported, not fatal", async () => {
  await store.commitImport(planFor(extracted, { newAccount: acct }));
  const [a, b, c] = await store.getAllTransactions(); // c is in 2025
  const commitsBefore = gh.log().length;
  const cats = await store.getCategories();
  cats.groups[0].name = "Money In";
  const r = await store.applyEdits({
    txEdits: [
      { key: "1", accountId: acct.id, id: a.id, date: a.date, state: { note: "paycheck", category: "income", splits: [] } },
      { key: "2", accountId: acct.id, id: c.id, date: c.date, state: { note: "", category: "dining", splits: [] } },
      { key: "3", accountId: acct.id, id: "nope", date: "2026-01-01", state: { note: "x" } },
    ],
    categories: cats,
  });
  assert.deepEqual(r.applied, ["1", "2"]);
  assert.equal(r.failed[0].key, "3");
  assert.equal(gh.log().length, commitsBefore + 1, "single commit");
  assert.match(gh.log()[0], /2 transaction edits \+ categories/);
  const all = await store.getAllTransactions();
  assert.equal(all.find((t) => t.id === a.id).note, "paycheck");
  assert.equal(all.find((t) => t.id === c.id).category, "dining");
  assert.equal((await store.getCategories()).groups[0].name, "Money In");
  assert.equal(JSON.parse(gh.files().get("corrections.json")).corrections.length, 2);
});

test("refuses a public repo", async () => {
  gh = fakeGitHub({ isPrivate: false });
  globalThis.fetch = gh.fetch;
  await assert.rejects(store.commitImport(planFor(extracted, { newAccount: acct })), /PUBLIC/);
  assert.equal(gh.files().size, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbox, pendingCount } from "../web/lib/outbox.js";

function memStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: structuredClone(data[k]) }), set: async (o) => { for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v); } };
}
const entry = (id, note) => ({ type: "tx", entry: { accountId: "a", id, date: "2026-11-01", state: { note, category: null, splits: [] } } });

test("edits coalesce per transaction and flush as one batch", async () => {
  const storage = memStorage();
  const alarms = [];
  const calls = [];
  const ob = createOutbox({ storage, alarms: { create: (n, o) => alarms.push(o.when) }, applyEdits: async (b) => { calls.push(b); return { applied: b.txEdits.map((e) => e.key), failed: [] }; }, now: () => 1000 });
  await ob.queue(entry("t1", "a"));
  await ob.queue(entry("t1", "b")); // same txn: replaces
  await ob.queue(entry("t2", "c"));
  assert.equal(pendingCount(await ob.read()), 2);
  assert.deepEqual(alarms, [61000], "one alarm, a minute after the first edit");

  const o = await ob.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].txEdits.map((e) => e.state.note), ["b", "c"]);
  assert.equal(pendingCount(o), 0);
  assert.equal(o.since, null);
  assert.equal(o.lastFlush.ok, true);
});

test("an edit made while the commit is in flight is kept for the next flush", async () => {
  const storage = memStorage();
  let release;
  const ob = createOutbox({ storage, alarms: { create() {} }, applyEdits: (b) => new Promise((r) => { release = () => r({ applied: b.txEdits.map((e) => e.key), failed: [] }); }) });
  await ob.queue(entry("t1", "first"));
  const flushing = ob.flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await ob.read()).flushing, true);
  await ob.queue(entry("t1", "second")); // edited again mid-save
  release();
  const o = await flushing;
  assert.equal(pendingCount(o), 1);
  assert.equal(o.tx["a/t1"].state.note, "second");
});

test("a failed flush keeps everything and schedules a retry; per-edit failures are reported", async () => {
  const storage = memStorage();
  const alarms = [];
  let fail = true;
  const ob = createOutbox({
    storage, alarms: { create: (n, o) => alarms.push(o.when) }, now: () => 5000,
    applyEdits: async (b) => { if (fail) throw new Error("offline"); return { applied: [b.txEdits[0].key], failed: [{ key: b.txEdits[1].key, error: "gone" }] }; },
  });
  await ob.queue(entry("t1", "x"));
  await ob.queue(entry("t2", "y"));
  let o = await ob.flush();
  assert.equal(pendingCount(o), 2);
  assert.equal(o.lastFlush.error, "offline");
  assert.equal(alarms.at(-1), 65000);

  fail = false;
  o = await ob.flush();
  assert.equal(pendingCount(o), 0);
  assert.deepEqual(o.failed.map((f) => f.error), ["gone"]);
  assert.equal((await ob.clearFailed()).failed.length, 0);
});

test("recover() clears a stuck flushing flag after a worker restart", async () => {
  const storage = memStorage();
  storage.data.outbox = { tx: { "a/t1": { accountId: "a", id: "t1", date: "2026-11-01", state: {}, rev: 1 } }, flushing: true, since: 1 };
  const ob = createOutbox({ storage, alarms: { create() {} }, applyEdits: async () => ({ applied: [], failed: [] }) });
  await ob.recover();
  assert.equal((await ob.read()).flushing, false);
});

test("queueMany: a bulk edit is one storage write", async () => {
  const storage = memStorage();
  let writes = 0;
  const set = storage.set;
  storage.set = async (o) => { writes++; return set(o); };
  const ob = createOutbox({ storage, alarms: { create() {} }, applyEdits: async () => ({ applied: [], failed: [] }) });
  await ob.queueMany([entry("t1", "a"), entry("t2", "b"), entry("t3", "c")]);
  assert.equal(writes, 1);
  assert.equal(pendingCount(await ob.read()), 3);
});

// Local write buffer. Dashboard edits land here instantly (localStorage survives tab close and
// browser crash); everything is flushed as ONE GitHub commit about a minute after the first
// unsaved change, or immediately on "Save now" / tab close.
//
// Stored under "outbox" in the given storage:
//   { tx: { "<accountId>/<txId>": { accountId, id, date, state, rev } },
//     categories: { doc, rev } | null,
//     since: ms of oldest unsaved edit | null,  flushing: bool,
//     lastFlush: { at, ok, error?, applied? } | null,
//     failed: [{ key, error, at }] }   edits GitHub rejected (e.g. transaction no longer exists)
//
// All mutations go through one promise chain, so queue/flush never interleave read-modify-writes.

export const OUTBOX_KEY = "outbox";
const EMPTY = () => ({ tx: {}, categories: null, since: null, flushing: false, lastFlush: null, failed: [] });
export const pendingCount = (o) => Object.keys(o?.tx || {}).length + (o?.categories ? 1 : 0);

export function createOutbox({ storage, alarms, applyEdits, flushMs = 60_000, now = () => Date.now() }) {
  let chain = Promise.resolve();
  let rev = now();
  const locked = (fn) => { const p = chain.then(() => fn()); chain = p.catch(() => {}); return p; };
  const read = async () => ({ ...EMPTY(), ...((await storage.get(OUTBOX_KEY))[OUTBOX_KEY] || {}) });
  const write = (o) => storage.set({ [OUTBOX_KEY]: o });
  const schedule = (when) => alarms?.create("flush", { when });

  /** op: { type: "tx", entry: { accountId, id, date, state } } | { type: "categories", doc } */
  function queue(op) {
    return locked(async () => {
      const o = await read();
      const r = ++rev;
      if (op.type === "tx") o.tx[`${op.entry.accountId}/${op.entry.id}`] = { ...op.entry, rev: r };
      else if (op.type === "categories") o.categories = { doc: op.doc, rev: r };
      else throw new Error(`Unknown outbox op ${op.type}`);
      if (!o.since) { o.since = now(); schedule(o.since + flushMs); }
      await write(o);
      return o;
    });
  }

  async function flush() {
    const snap = await locked(async () => {
      const o = await read();
      if (o.flushing || !pendingCount(o)) return null;
      o.flushing = true;
      await write(o);
      return o;
    });
    if (!snap) return read();

    let result = null, error = null;
    try {
      result = await applyEdits({
        txEdits: Object.entries(snap.tx).map(([key, e]) => ({ key, ...e })),
        categories: snap.categories?.doc || null,
      });
    } catch (e) { error = e.message || String(e); }

    return locked(async () => {
      const o = await read();
      o.flushing = false;
      if (error) {
        o.lastFlush = { at: now(), ok: false, error };
        schedule(now() + flushMs); // retry
      } else {
        // drop what was saved, unless it was edited again while the commit was in flight
        for (const [key, e] of Object.entries(snap.tx)) if (o.tx[key]?.rev === e.rev) delete o.tx[key];
        if (snap.categories && o.categories?.rev === snap.categories.rev) o.categories = null;
        for (const f of result.failed) o.failed.push({ ...f, at: now() });
        o.lastFlush = { at: now(), ok: true, applied: result.applied.length };
        o.since = pendingCount(o) ? now() : null;
        if (o.since) schedule(o.since + flushMs);
      }
      await write(o);
      return o;
    });
  }

  /** After a service-worker restart a flush can't still be running. */
  const recover = () => locked(async () => {
    const o = await read();
    if (o.flushing) { o.flushing = false; await write(o); }
    if (pendingCount(o)) schedule(Math.max(now(), (o.since || now()) + flushMs));
  });

  const clearFailed = () => locked(async () => { const o = await read(); o.failed = []; await write(o); return o; });

  return { queue, flush, read, recover, clearFailed };
}

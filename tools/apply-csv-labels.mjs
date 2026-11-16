// Applies hand-kept spreadsheet labels (note, category, splits, counted-amount overrides) to the
// transactions already in the data repo, matching on account + amount + date.
//
//   node tools/apply-csv-labels.mjs <labels.csv> [--write] [--out unmatched.csv] [--window 4]
//
// Without --write it's a dry run: it prints what would happen and writes the "unmatched" CSV.
// Safe to re-run (e.g. after importing more history): transactions that already carry the same
// labels are skipped, and ones you've labeled differently in the dashboard are never overwritten.
//
// CSV columns (no header names needed; the first row is skipped):
//   A account last 4 (or Cash/Venmo/...)   B date M/D/YYYY   C description → note   D amount (spending
//   positive, refunds negative)   E category name   F original bank amount when the row is part of a
//   split, or when D overrides it (e.g. D = 0 for something reimbursed). Other columns are ignored.
//   Consecutive rows with the same account, date and F are one bank transaction split into parts.
//
// Auth: GH_TOKEN env var, else `gh auth token`. Repo: --repo owner/name (default from GH_DATA_REPO).
import fs from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const VALUED = ["--out", "--window", "--repo"];
const csvPath = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
if (!csvPath) { console.error("usage: node tools/apply-csv-labels.mjs <labels.csv> [--write] [--out unmatched.csv] [--repo owner/name]"); process.exit(1); }
const WRITE = args.includes("--write");
const WINDOW = Number(opt("--window", 4));
const OUT = opt("--out", csvPath.replace(/\.csv$/i, "") + "-unmatched.csv");
const [owner, repoName] = (opt("--repo", process.env.GH_DATA_REPO || "") || "").split("/");
if (!owner || !repoName) { console.error("Pass --repo owner/name (your private data repo)."); process.exit(1); }

const token = process.env.GH_TOKEN || execSync("gh auth token").toString().trim();
globalThis.chrome = { storage: { local: { get: async () => ({ settings: { ghOwner: owner, ghRepo: repoName, ghBranch: "main", ghToken: token } }) } } };
const store = await import("../extension/src/lib/store.js");
const { categoryIndex } = await import("../extension/src/lib/categories.js");
const { resolveSplits } = await import("../extension/src/lib/splits.js");
const { editableState, applyState } = await import("../extension/src/lib/edits.js");

// ---------- CSV ----------
function parseCsv(t) {
  const rows = []; let r = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { r.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; r.push(f); rows.push(r); r = []; f = ""; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}
const toCsv = (rows) => rows.map((r) => r.map((v) => { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(",")).join("\r\n") + "\r\n";
function isoDate(d) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec((d || "").trim());
  return m ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}
/** "$1,234.56" / "-$5.39" / "0" -> cents; "" -> null; anything else -> NaN */
function cents(s) {
  let t = (s || "").trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$,\s]/g, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
  return (neg ? -1 : 1) * Math.round(parseFloat(t) * 100);
}
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

const all = parseCsv(fs.readFileSync(csvPath, "utf8"));
const header = all[0];
const rows = all.slice(1).map((r, i) => ({ line: i + 2, r, acct: r[0].trim(), date: isoDate(r[1]), desc: r[2].trim(), amt: cents(r[3]), cat: r[4].trim(), orig: cents(r[5]), origRaw: r[5].trim() }))
  .filter((x) => x.acct && x.date); // skip blank lines and month headings

// ---------- data ----------
const [accounts, txns, catsDoc] = await Promise.all([store.listAccounts(), store.getAllTransactions(), store.getCategories()]);
const catByName = new Map([...categoryIndex(catsDoc).values()].map((c) => [c.name.trim().toLowerCase(), c.id]));
const acctByLast4 = new Map(accounts.filter((a) => a.last4).map((a) => [a.last4, a]));
const range = {};
for (const t of txns) { const r = (range[t.accountId] ||= { min: t.date, max: t.date }); if (t.date < r.min) r.min = t.date; if (t.date > r.max) r.max = t.date; }
const today = new Date().toISOString().slice(0, 10);

// ---------- rows -> logical bank transactions ----------
const leftovers = []; // { rows, reason }
const groups = [];
for (let i = 0; i < rows.length; i++) {
  const x = rows[i];
  const g = [x];
  if (x.origRaw) while (rows[i + 1] && rows[i + 1].line === g.at(-1).line + 1 && rows[i + 1].acct === x.acct && rows[i + 1].date === x.date && rows[i + 1].origRaw === x.origRaw) g.push(rows[++i]);
  groups.push(g);
}

const reject = (g, reason) => leftovers.push({ rows: g, reason });
const labeled = [];
for (const g of groups) {
  const h = g[0];
  if (g.some((x) => Number.isNaN(x.amt) || x.amt == null)) { reject(g, "couldn't read the amount (column D)"); continue; }
  if (h.origRaw && Number.isNaN(h.orig)) { reject(g, `couldn't read the original amount in column F ("${h.origRaw}")`); continue; }
  const catIds = g.map((x) => (x.cat ? catByName.get(x.cat.toLowerCase()) : null));
  if (g.some((x, k) => x.cat && !catIds[k])) { reject(g, `category not in your category list: ${g.filter((x, k) => x.cat && !catIds[k]).map((x) => x.cat).join(", ")}`); continue; }
  const account = acctByLast4.get(h.acct);
  if (!account) { reject(g, /^\d{4}$/.test(h.acct) ? `account …${h.acct} hasn't been imported` : `"${h.acct}" isn't a bank account the extension imports`); continue; }

  const sumD = g.reduce((s, x) => s + x.amt, 0);
  const bankCsv = h.orig ?? sumD;              // spreadsheet sign: spending positive
  const bank = -bankCsv;                       // data sign: money out negative
  const counted = -sumD;
  if (bank === 0) { reject(g, "the bank amount is $0"); continue; }
  if (counted !== 0 && Math.sign(counted) !== Math.sign(bank)) { reject(g, "the tracked amount goes the opposite direction from the original amount"); continue; }

  const notes = [...new Set(g.map((x) => x.desc).filter(Boolean))];
  const state = { note: notes.join("; "), category: null, splits: [], overrideCents: counted === bank ? null : counted };
  if (g.length === 1 || counted === 0) {
    if (g.length > 1 && new Set(catIds).size > 1) { reject(g, "split rows that add up to $0 with different categories"); continue; }
    state.category = catIds[0] || null;
  } else {
    state.splits = g.map((x, k) => ({ id: `csv${h.line}_${k}`, amountCents: -x.amt, category: catIds[k] || null, ...(x.desc && notes.length > 1 ? { note: x.desc } : {}) }));
    const r = resolveSplits(counted, state.splits);
    if (!r.ok) { reject(g, `split parts don't work as a split: ${r.error}`); continue; }
  }
  labeled.push({ g, account, date: h.date, bank, state });
}

// ---------- matching ----------
// Candidates: same account and exact bank amount, within ±WINDOW days. Pairs are only taken when
// the choice is unambiguous: a single candidate both ways, or ties among identically-labeled rows,
// or a unique exact-date match.
const sameLabel = (a, b) => JSON.stringify({ ...a.state, splits: a.state.splits.map(({ id, ...s }) => s) }) === JSON.stringify({ ...b.state, splits: b.state.splits.map(({ id, ...s }) => s) });
const txBucket = new Map();
for (const t of txns) { const k = `${t.accountId}|${t.amountCents}`; if (!txBucket.has(k)) txBucket.set(k, []); txBucket.get(k).push(t); }
const lBucket = new Map();
for (const l of labeled) { const k = `${l.account.id}|${l.bank}`; if (!lBucket.has(k)) lBucket.set(k, []); lBucket.get(k).push(l); }

const matches = []; // { l, t, how }
for (const [k, ls] of lBucket) {
  const ts = txBucket.get(k) || [];
  const near = (l) => ts.filter((t) => dayDiff(l.date, t.date) <= WINDOW);
  const nearL = (t) => ls.filter((l) => dayDiff(l.date, t.date) <= WINDOW);
  const takenT = new Set(), takenL = new Set();
  // pass 1: one-to-one
  for (const l of ls) {
    const c = near(l);
    if (c.length === 1 && nearL(c[0]).length === 1) { matches.push({ l, t: c[0], how: "unique" }); takenT.add(c[0]); takenL.add(l); }
  }
  // pass 2: clusters — closest pairs first; accept when every competitor carries the same labels, or the date match is uniquely exact
  const pairs = [];
  for (const l of ls) if (!takenL.has(l)) for (const t of near(l)) if (!takenT.has(t)) pairs.push({ l, t, d: dayDiff(l.date, t.date) });
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    if (takenL.has(p.l) || takenT.has(p.t)) continue;
    const rivalsL = nearL(p.t).filter((l) => l !== p.l && !takenL.has(l));
    const rivalsT = near(p.l).filter((t) => t !== p.t && !takenT.has(t));
    const interchangeable = rivalsL.every((l) => sameLabel(l, p.l));
    const exactUnique = p.d === 0 && !rivalsL.some((l) => l.date === p.t.date) && !rivalsT.some((t) => t.date === p.l.date);
    if (interchangeable || exactUnique) { matches.push({ l: p.l, t: p.t, how: interchangeable ? "same-labels" : "exact-date" }); takenL.add(p.l); takenT.add(p.t); }
  }
  for (const l of ls) {
    if (takenL.has(l)) continue;
    const r = range[l.account.id];
    const c = near(l);
    if (l.date > today) reject(l.g, "date is in the future");
    else if (!r || l.date < r.min || l.date > r.max) reject(l.g, `outside the imported dates for …${l.account.last4} (${r ? `${r.min} to ${r.max}` : "none yet"})`);
    else if (c.length) reject(l.g, `several ${(-l.bank / 100).toFixed(2)} transactions near this date with different labels; couldn't tell which is which`);
    else {
      const sameAmt = (txBucket.get(k) || []).map((t) => t.date).sort((a, b) => dayDiff(a, l.date) - dayDiff(b, l.date))[0];
      reject(l.g, `no ${(-l.bank / 100).toFixed(2)} transaction within ${WINDOW} days in …${l.account.last4}${sameAmt ? ` (closest same amount: ${sameAmt})` : ""}`);
    }
  }
}

// ---------- don't clobber dashboard edits ----------
const edits = [];
let alreadyDone = 0;
const isBlank = (t) => !t.note && !t.category && !t.splits?.length && !Number.isInteger(t.overrideCents);
for (const m of matches) {
  const probe = structuredClone(m.t);
  applyState(probe, m.l.state, "x");
  const before = JSON.stringify(editableState(m.t)), after = JSON.stringify(editableState(probe));
  if (before === after) { alreadyDone++; continue; }
  if (!isBlank(m.t)) { reject(m.l.g, `already labeled differently in the dashboard (${m.t.category || (m.t.splits?.length ? "split" : m.t.note || "edited")})`); continue; }
  edits.push({ key: `${m.l.g[0].line}`, accountId: m.t.accountId, id: m.t.id, date: m.t.date, state: m.l.state });
}

// ---------- report ----------
const nRows = (list) => list.reduce((s, x) => s + (x.rows || x.l.g).length, 0);
const reasons = {};
for (const l of leftovers) { const key = l.reason.replace(/\(.*\)|\d+\.\d\d|…\d{4}|"[^"]*"|\d{4}-\d\d-\d\d/g, "…").replace(/\s+/g, " ").trim(); reasons[key] = (reasons[key] || 0) + l.rows.length; }
console.log(`CSV: ${rows.length} rows → ${groups.length} bank transactions (${groups.filter((g) => g.length > 1).length} split groups)`);
console.log(`Matched: ${matches.length} (${nRows(matches)} rows): ${Object.entries(matches.reduce((a, m) => ((a[m.how] = (a[m.how] || 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`  to write: ${edits.length} · already applied: ${alreadyDone} · splits: ${edits.filter((e) => e.state.splits.length).length} · overrides: ${edits.filter((e) => e.state.overrideCents != null).length} (to $0: ${edits.filter((e) => e.state.overrideCents === 0).length})`);
console.log(`Unmatched rows: ${nRows(leftovers)}`);
for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

const width = Math.max(header.length, ...leftovers.flatMap((l) => l.rows.map((x) => x.r.length)));
const pad = (r) => [...r, ...Array(width - r.length).fill("")];
const out = [[...pad(header), "CSV line", "Why it wasn't applied"]];
for (const l of leftovers.sort((a, b) => a.rows[0].line - b.rows[0].line)) for (const x of l.rows) out.push([...pad(x.r), x.line, l.reason]);
fs.writeFileSync(OUT, toCsv(out));
console.log(`Wrote ${OUT}`);

if (WRITE && edits.length) {
  const r = await store.applyEdits({ txEdits: edits });
  console.log(`Committed: ${r.applied.length} applied, ${r.failed.length} failed${r.failed.length ? ": " + r.failed.slice(0, 5).map((f) => f.error).join("; ") : ""}`);
} else if (!WRITE) console.log("Dry run. Re-run with --write to commit.");

// Data-repo layout and operations. See DATA_LAYOUT.md for the schema.
import { GitHubRepo } from "./github.js";
import { resolveSplits } from "./splits.js";
import { applyState, editableState, EDITABLE_FIELDS, trackedCents } from "./edits.js";
import { normalizeCategories, validateCategories } from "./categories.js";
import { storage } from "./platform.js";

export const DEFAULT_CATEGORIES = [
  { id: "income", name: "Income", group: "Income" },
  { id: "transfer", name: "Transfer / Card Payment", group: "Transfers" },
  { id: "housing", name: "Rent / Mortgage", group: "Housing" },
  { id: "utilities", name: "Utilities", group: "Housing" },
  { id: "groceries", name: "Groceries", group: "Food" },
  { id: "dining", name: "Restaurants & Coffee", group: "Food" },
  { id: "transport", name: "Gas & Transportation", group: "Transport" },
  { id: "auto", name: "Car Payment / Insurance / Maintenance", group: "Transport" },
  { id: "shopping", name: "Shopping", group: "Lifestyle" },
  { id: "entertainment", name: "Entertainment", group: "Lifestyle" },
  { id: "subscriptions", name: "Subscriptions", group: "Lifestyle" },
  { id: "travel", name: "Travel", group: "Lifestyle" },
  { id: "health", name: "Health & Medical", group: "Health" },
  { id: "insurance", name: "Insurance (non-auto)", group: "Bills" },
  { id: "phone_internet", name: "Phone & Internet", group: "Bills" },
  { id: "fees", name: "Bank Fees & Interest", group: "Bills" },
  { id: "investing", name: "Investment Contributions", group: "Savings" },
  { id: "gifts", name: "Gifts & Donations", group: "Other" },
  { id: "other", name: "Other", group: "Other" },
];

const INITIAL_FILES = () => ({
  "accounts.json": { version: 1, accounts: [] },
  "categories.json": normalizeCategories({ version: 1, categories: DEFAULT_CATEGORIES }),
  "rules.json": { version: 1, rules: [] },
  "corrections.json": { version: 1, corrections: [] },
  "balances.json": { version: 1, snapshots: [] },
  "imports.json": { version: 1, imports: [] },
  "ai-notes.md": "# Categorization notes\n\nMaintained by the categorizer. Learned patterns, merchant quirks, and user preferences go here.\n",
});

export async function getSettings() {
  const { settings } = await storage().get("settings");
  return settings || {};
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  settings.ghBranch ||= "main";
  await storage().set({ settings });
  return settings;
}

export async function getRepo() {
  const s = await getSettings();
  return new GitHubRepo({ owner: s.ghOwner, repo: s.ghRepo, branch: s.ghBranch || "main", token: s.ghToken });
}

export const txPath = (accountId, year) => `transactions/${accountId}/${year}.json`;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const yearOf = (date) => date.slice(0, 4);
const sortTx = (list) => list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

export async function initDataRepo() {
  const repo = await getRepo();
  const info = await repo.repoInfo();
  if (!info.private) throw new Error(`Refusing to use ${info.full_name}: repository is PUBLIC. Make it private first.`);
  if (!(await repo.headSha())) {
    await repo.initEmptyRepo("# Finance data\n\nPrivate data store for the Finance Dashboard extension. Do not make public.\n");
  }
  const r = await repo.transact(async (_read, readText) => {
    const files = [];
    for (const [path, content] of Object.entries(INITIAL_FILES())) {
      if ((await readText(path)) == null) files.push({ path, content });
    }
    return { files, message: "Initialize data files" };
  });
  return { created: r.result.files.map((f) => f.path) };
}

/** Writes call this so a never-initialized repo can't silently swallow a save. */
const checkedPrivate = new Set(); // "owner/repo" already confirmed private this session
async function ensureInitialized(repo) {
  const key = `${repo.owner}/${repo.repo}`;
  if (!checkedPrivate.has(key)) {
    const info = await repo.repoInfo();
    if (!info.private) throw new Error(`Refusing to write to ${info.full_name}: repository is PUBLIC. Make it private first.`);
    checkedPrivate.add(key);
  }
  const head = await repo.headSha();
  if (head && (await repo.readText("accounts.json", head)) != null) return;
  await initDataRepo();
}

export async function testConnection() {
  const repo = await getRepo();
  const info = await repo.repoInfo();
  const head = await repo.headSha();
  return { fullName: info.full_name, private: info.private, empty: !head, canPush: !!info.permissions?.push };
}

/** What the dashboard needs to explain an empty screen. */
export async function getStatus() {
  const s = await getSettings();
  if (!s.ghToken || !s.ghOwner || !s.ghRepo) return { configured: false };
  const repo = await getRepo();
  const head = await repo.headSha();
  if (!head) return { configured: true, repo: `${s.ghOwner}/${s.ghRepo}`, initialized: false };
  const [accounts, imports] = await Promise.all([
    repo.readJSON("accounts.json", head, null),
    repo.readJSON("imports.json", head, null),
  ]);
  const list = imports?.imports || [];
  return {
    configured: true,
    repo: `${s.ghOwner}/${s.ghRepo}`,
    initialized: !!accounts,
    head,
    accountCount: accounts?.accounts?.length || 0,
    importCount: list.length,
    lastImport: list[list.length - 1] || null,
  };
}

export async function listAccounts() {
  const repo = await getRepo();
  const head = await repo.headSha();
  if (!head) return [];
  return (await repo.readJSON("accounts.json", head, { accounts: [] })).accounts;
}

export async function upsertAccount(acct) {
  const repo = await getRepo();
  await ensureInitialized(repo);
  let saved;
  await repo.transact(async (read) => {
    const doc = await read("accounts.json", { version: 1, accounts: [] });
    const i = doc.accounts.findIndex((a) => a.id === acct.id);
    saved = { createdAt: new Date().toISOString(), ...(i >= 0 ? doc.accounts[i] : {}), ...acct };
    if (i >= 0) doc.accounts[i] = saved; else doc.accounts.push(saved);
    return { files: [{ path: "accounts.json", content: doc }], message: `Account: ${saved.id}` };
  });
  return saved;
}

export async function getCategories() {
  const repo = await getRepo();
  const head = await repo.headSha();
  const doc = head ? await repo.readJSON("categories.json", head, null) : null;
  return normalizeCategories(doc || { version: 1, categories: DEFAULT_CATEGORIES });
}

export async function saveCategories(doc) {
  validateCategories(doc);
  const repo = await getRepo();
  await ensureInitialized(repo);
  await repo.transact(async () => ({ files: [{ path: "categories.json", content: doc }], message: "Update categories" }));
  return doc;
}

const corrEntry = (t, accountId, c, at) => ({ at, txId: t.id, accountId, description: t.description, merchant: t.merchant, amountCents: t.amountCents, ...c });

/** Finds a stored transaction by id, looking in its year's file and the neighbors (dates can cross Dec/Jan when pending posts). */
async function locate(getDoc, accountId, id, date) {
  const y = +yearOf(date);
  for (const yy of [y, y + 1, y - 1]) {
    const path = txPath(accountId, yy);
    const doc = await getDoc(path);
    const t = doc?.transactions.find((x) => x.id === id);
    if (t) return { t, path };
  }
  return null;
}

/**
 * Flushes a batch of buffered edits as ONE commit (see lib/outbox.js).
 * txEdits: [{ key, accountId, id, date, state }]; categories: full v2 doc or null.
 * Per-edit problems (transaction gone) don't sink the batch: they come back in `failed`.
 */
export async function applyEdits({ txEdits = [], categories = null }) {
  if (categories) validateCategories(categories);
  const repo = await getRepo();
  await ensureInitialized(repo);
  let out;
  await repo.transact(async (read) => {
    out = { applied: [], failed: [] };
    const now = new Date().toISOString();
    const docs = new Map();
    const getDoc = async (p) => { if (!docs.has(p)) docs.set(p, await read(p, null)); return docs.get(p); };
    const touched = new Set();
    const corrections = [];
    for (const e of txEdits) {
      const hit = await locate(getDoc, e.accountId, e.id, e.date);
      if (!hit) { out.failed.push({ key: e.key, error: "Transaction no longer exists (was it removed by an import?)" }); continue; }
      try {
        const { correction } = applyState(hit.t, e.state, now, { lenient: true });
        if (correction) corrections.push(corrEntry(hit.t, e.accountId, correction, now));
        touched.add(hit.path);
        out.applied.push(e.key);
      } catch (err) { out.failed.push({ key: e.key, error: err.message }); }
    }
    const files = [...touched].map((p) => ({ path: p, content: docs.get(p) }));
    if (corrections.length) {
      const corr = await read("corrections.json", { version: 1, corrections: [] });
      corr.corrections.push(...corrections);
      files.push({ path: "corrections.json", content: corr });
    }
    if (categories) files.push({ path: "categories.json", content: categories });
    const parts = [out.applied.length && `${out.applied.length} transaction edit${out.applied.length === 1 ? "" : "s"}`, categories && "categories"].filter(Boolean);
    return { files, message: `Dashboard: ${parts.join(" + ") || "no changes"}` };
  });
  return out;
}

// ---------- AI notes: the categorizer's long-term memory (ai-notes.md in the data repo) ----------
export const AI_NOTES_FILE = "ai-notes.md";

export async function getNotes() {
  const repo = await getRepo();
  const head = await repo.headSha();
  return { ai: head ? (await repo.readText(AI_NOTES_FILE, head)) || "" : "" };
}

export async function saveNotes({ ai }) {
  if (typeof ai !== "string") throw new Error("Nothing to save.");
  const repo = await getRepo();
  await ensureInitialized(repo);
  await repo.transact(async () => ({ files: [{ path: AI_NOTES_FILE, content: ai.trimEnd() + "\n" }], message: "Update AI notes" }));
  return getNotes();
}

/** Every file in the data repo, read at one commit so the set is consistent. */
export async function exportDataFiles() {
  const repo = await getRepo();
  const head = await repo.headSha();
  if (!head) throw new Error("The data repo is empty: nothing to export.");
  const files = [];
  const walk = async (dir) => {
    for (const item of await repo.listDir(dir, head)) {
      if (item.type === "dir") await walk(item.path);
      else if (item.type === "file") files.push({ path: item.path, content: await repo.readText(item.path, head) });
    }
  };
  await walk("");
  return { head, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Single immediate edit (patch of note/category/splits). The dashboard uses applyEdits via the outbox instead. */
export async function updateTransaction({ accountId, id, date, patch }) {
  for (const k of Object.keys(patch)) if (!EDITABLE_FIELDS.includes(k)) throw new Error(`Field "${k}" can't be edited.`);
  const repo = await getRepo();
  let saved;
  await repo.transact(async (read) => {
    const hit = await locate((p) => read(p, null), accountId, id, date);
    if (!hit) throw new Error("Transaction not found. It may have moved (Reload and try again).");
    const doc = await read(hit.path, null); // locate's read returned a different object; re-find in this one
    const t = doc.transactions.find((x) => x.id === id);
    const now = new Date().toISOString();
    const { correction } = applyState(t, { ...editableState(t), ...patch }, now);
    const files = [{ path: hit.path, content: doc }];
    if (correction) {
      const corr = await read("corrections.json", { version: 1, corrections: [] });
      corr.corrections.push(corrEntry(t, accountId, correction, now));
      files.push({ path: "corrections.json", content: corr });
    }
    saved = t;
    return { files, message: `Edit ${t.date} ${t.description.slice(0, 40)}` };
  });
  return saved;
}

/** Stored transactions for an account across the given years. */
export async function getTransactions(accountId, years) {
  const repo = await getRepo();
  const head = await repo.headSha();
  if (!head) return [];
  const out = [];
  for (const y of years) {
    const doc = await repo.readJSON(txPath(accountId, y), head, null);
    if (doc) out.push(...doc.transactions);
  }
  return out;
}

export async function getAllTransactions() {
  const repo = await getRepo();
  const head = await repo.headSha();
  if (!head) return [];
  const out = [];
  for (const dir of await repo.listDir("transactions", head)) {
    if (dir.type !== "dir") continue;
    for (const f of await repo.listDir(dir.path, head)) {
      if (!f.name.endsWith(".json")) continue;
      const doc = await repo.readJSON(f.path, head, null);
      if (doc) out.push(...doc.transactions);
    }
  }
  return sortTx(out);
}

/**
 * Commits one import in a single git commit.
 * plan: { accountId, add: [extracted], updates: [{existingId, incoming}], removeIds: [], meta: {...}, balanceCents? }
 */
export async function commitImport(plan) {
  const repo = await getRepo();
  await ensureInitialized(repo);
  const importId = `imp_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const now = new Date().toISOString();
  const r = await repo.transact(async (read) => {
    // Guard: never write one account's page into another account.
    const acctDoc = await read("accounts.json", { version: 1, accounts: [] });
    const target = acctDoc.accounts.find((a) => a.id === plan.accountId) || plan.newAccount;
    if (!target) throw new Error(`Unknown account ${plan.accountId}.`);
    if (plan.detectedLast4 && target.last4 && plan.detectedLast4 !== target.last4) {
      throw new Error(`Blocked: the page shows account …${plan.detectedLast4} but the target is ${target.name} …${target.last4}. Nothing was saved.`);
    }

    const years = new Set([
      ...plan.add.map((t) => yearOf(t.date)),
      ...plan.updates.map((u) => yearOf(u.incoming.date)),
      ...(plan.touchYears || []),
    ]);
    const docs = {};
    for (const y of years) docs[y] = await read(txPath(plan.accountId, y), { version: 1, accountId: plan.accountId, year: +y, transactions: [] });

    // updates & removals may move a txn across years (pending in Dec, posted in Jan)
    const all = Object.values(docs).flatMap((d) => d.transactions);
    const byId = new Map(all.map((t) => [t.id, t]));
    for (const u of plan.updates) {
      const t = byId.get(u.existingId);
      if (!t) continue;
      Object.assign(t, {
        date: u.incoming.date,
        amountCents: u.incoming.amountCents,
        status: u.incoming.status,
        description: u.incoming.description || t.description,
        postedDate: u.incoming.postedDate ?? t.postedDate ?? null,
        bankRef: u.incoming.bankRef ?? t.bankRef ?? null,
        updatedAt: now,
        updatedBy: importId,
      });
      // amount may have changed (pending tip): re-balance the user's splits
      if (t.splits?.length) {
        const r = resolveSplits(trackedCents(t), t.splits);
        if (r.ok) { t.splits = r.splits; delete t.splitsNeedReview; } else t.splitsNeedReview = true;
      }
    }
    const removed = new Set(plan.removeIds || []);
    const added = plan.add.map((t) => ({
      id: newId(),
      accountId: plan.accountId,
      date: t.date,
      postedDate: t.postedDate || null,
      amountCents: t.amountCents,
      description: t.description,
      bankRef: t.bankRef || null,
      merchant: t.merchantGuess || null,
      status: t.status || "posted",
      category: null,
      categorySource: null,
      source: plan.meta?.extractorId || "manual",
      importId,
      importedAt: now,
    }));

    // redistribute everything into year files
    const merged = [...all.filter((t) => !removed.has(t.id)), ...added];
    for (const y of Object.keys(docs)) docs[y].transactions = [];
    for (const t of merged) {
      const y = yearOf(t.date);
      if (!docs[y]) docs[y] = { version: 1, accountId: plan.accountId, year: +y, transactions: [] };
      docs[y].transactions.push(t);
    }
    const files = Object.entries(docs).map(([y, d]) => ({ path: txPath(plan.accountId, y), content: { ...d, transactions: sortTx(d.transactions) } }));

    // new account is created in the same commit as its first transactions
    if (plan.newAccount && !acctDoc.accounts.some((a) => a.id === plan.newAccount.id)) {
      acctDoc.accounts.push({ ...plan.newAccount, createdAt: now });
      files.push({ path: "accounts.json", content: acctDoc });
    }

    const imports = await read("imports.json", { version: 1, imports: [] });
    imports.imports.push({
      id: importId, accountId: plan.accountId, at: now,
      added: added.length, updated: plan.updates.length, removed: removed.size, duplicates: plan.duplicateCount || 0,
      ...plan.meta,
    });
    files.push({ path: "imports.json", content: imports });

    if (plan.balanceCents != null) {
      const bal = await read("balances.json", { version: 1, snapshots: [] });
      bal.snapshots.push({ accountId: plan.accountId, date: now.slice(0, 10), balanceCents: plan.balanceCents, source: importId });
      files.push({ path: "balances.json", content: bal });
    }
    return { files, message: `Import ${plan.accountId}: +${added.length} ~${plan.updates.length} -${removed.size}` };
  });
  return { importId, sha: r.sha };
}

// The dashboard's data layer. GitHub calls go straight from the page (no server).
// The auto-save timer only runs while a dashboard tab is open; edits made before closing are kept
// in localStorage and saved the next time the page opens.
import * as store from "../../extension/src/lib/store.js";
import { storage } from "../../extension/src/lib/platform.js";
import { createOutbox, pendingCount } from "./outbox.js";
import { makeZip } from "./zip.js";
import { callClaude, DEFAULT_MODEL, MODELS } from "./ai.js";

/** chrome.alarms-like timer that fires only while the page is open. */
function pageAlarms(onFire) {
  const timers = new Map();
  return {
    create(name, { when }) {
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => { timers.delete(name); onFire(name); }, Math.max(0, when - Date.now())));
    },
  };
}

let outbox;
function getOutbox() {
  if (!outbox) {
    outbox = createOutbox({ storage: storage(), alarms: pageAlarms(() => outbox.flush()), applyEdits: store.applyEdits });
    outbox.recover(); // clears a flag left by a tab that closed mid-save; reschedules pending edits
  }
  return outbox;
}

/** Connection settings without the secrets themselves. */
async function getConnection() {
  const s = await store.getSettings();
  return {
    ghOwner: s.ghOwner || "", ghRepo: s.ghRepo || "", ghBranch: s.ghBranch || "main", hasToken: !!s.ghToken,
    hasAnthropicKey: !!s.anthropicKey, aiModel: MODELS[s.aiModel] ? s.aiModel : DEFAULT_MODEL,
  };
}

/** Blank secret fields keep the saved value; `forget` lists secrets to delete. */
async function saveConnection({ settings, forget = [] }) {
  const patch = {};
  for (const k of ["ghOwner", "ghRepo", "ghBranch", "aiModel"]) if (k in settings) patch[k] = String(settings[k]).trim();
  for (const k of ["ghToken", "anthropicKey"]) if (settings[k]?.trim()) patch[k] = settings[k].trim();
  for (const k of forget) patch[k] = "";
  await store.saveSettings(patch);
  return getConnection();
}

/** Runs the categorizer request with the saved key (the key never leaves this module except to Anthropic). */
async function aiRequest({ system, user, onProgress, signal }) {
  const s = await store.getSettings();
  if (!s.anthropicKey) throw new Error("Add your Anthropic API key in Settings first.");
  const model = MODELS[s.aiModel] ? s.aiModel : DEFAULT_MODEL;
  return { model, ...(await callClaude({ apiKey: s.anthropicKey, model, system, user, onProgress, signal })) };
}

const AI_RUNS = "aiRuns";
const MAX_RUNS = 30;
const getAiRuns = async () => (await storage().get(AI_RUNS))[AI_RUNS] || [];
async function saveAiRun({ run }) {
  const runs = await getAiRuns();
  const i = runs.findIndex((r) => r.id === run.id);
  if (i >= 0) runs[i] = run; else runs.unshift(run); // updates keep their place in the log
  await storage().set({ [AI_RUNS]: runs.slice(0, MAX_RUNS) });
  return run;
}
async function deleteAiRun({ id }) { await storage().set({ [AI_RUNS]: (await getAiRuns()).filter((r) => r.id !== id) }); }

const RESTORE_README = `# Finance Dashboard backup

data/      Every file in the private data repo at the commit noted in backup.json: accounts,
           transactions, categories, balances, imports, AI notes. This is all of your data.
browser/   State that lives only in the dashboard's browser storage:
             settings.json       repo owner/name/branch and AI model (no token, no API key)
             ai-runs.json        the Logs tab (recent AI categorize sessions)
             unsaved-edits.json  edits not yet saved to GitHub when you exported (normally empty)
             ai-draft.json       the AI panel's form

## Restore
1. Create a new PRIVATE GitHub repo (leave it empty).
2. Put the contents of data/ in it and push:
     cd data && git init -b main && git add -A && git commit -m "Restore from backup"
     git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main
3. Open the dashboard, Settings: enter the owner, repo and a new token for that repo.
   Do the same in the extension's Options.
Code isn't included: it's in the public code repo.
`;

/** A .zip of everything needed to rebuild the app's data (never the token or API key). */
async function exportBackup() {
  const ob = getOutbox();
  let saveError = null;
  if (pendingCount(await ob.read())) {
    const o = await ob.flush(); // save first, so the repo copy includes recent edits
    if (o.lastFlush && !o.lastFlush.ok) saveError = o.lastFlush.error;
  }
  const { head, files } = await store.exportDataFiles();
  const s = await store.getSettings();
  const local = await storage().get([AI_RUNS, "outbox", "aiDraft"]);
  const at = new Date();
  const json = (v) => JSON.stringify(v ?? null, null, 2) + "\n";
  const entries = [
    { name: "README.md", data: RESTORE_README },
    { name: "backup.json", data: json({ version: 1, exportedAt: at.toISOString(), repo: `${s.ghOwner}/${s.ghRepo}`, branch: s.ghBranch || "main", commit: head, files: files.length }) },
    ...files.map((f) => ({ name: `data/${f.path}`, data: f.content ?? "" })),
    { name: "browser/settings.json", data: json({ ghOwner: s.ghOwner, ghRepo: s.ghRepo, ghBranch: s.ghBranch || "main", aiModel: s.aiModel || DEFAULT_MODEL }) },
    { name: "browser/ai-runs.json", data: json(local[AI_RUNS] || []) },
    { name: "browser/unsaved-edits.json", data: json(local.outbox || {}) },
    { name: "browser/ai-draft.json", data: json(local.aiDraft || {}) },
  ];
  const bytes = await makeZip(entries, { now: at });
  const stamp = at.toISOString().slice(0, 10);
  return { filename: `finance-backup-${stamp}.zip`, bytes, files: files.length, commit: head, saveError };
}

const handlers = {
  exportBackup,
  getNotes: () => store.getNotes(),
  saveNotes: (n) => store.saveNotes(n),
  aiRequest,
  getAiRuns,
  saveAiRun,
  deleteAiRun,
  getConnection,
  saveConnection,
  testConnection: () => store.testConnection(),
  getStatus: () => store.getStatus(),
  initDataRepo: () => store.initDataRepo(),
  listAccounts: () => store.listAccounts(),
  upsertAccount: ({ account }) => store.upsertAccount(account),
  getAllTransactions: () => store.getAllTransactions(),
  getCategories: () => store.getCategories(),
  getBudget: () => store.getBudget(),
  queueEdit: ({ op }) => getOutbox().queue(op),
  queueEdits: ({ ops }) => getOutbox().queueMany(ops),
  flushOutbox: () => getOutbox().flush(),
  getOutbox: () => getOutbox().read(),
  clearFailedEdits: () => getOutbox().clearFailed(),
};

/** Same shape as the extension's call(): call("getStatus"), call("queueEdit", { op }), ... */
export async function call(type, payload = {}) {
  const h = handlers[type];
  if (!h) throw new Error(`Unknown operation "${type}"`);
  return h(payload);
}

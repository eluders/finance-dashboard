// The dashboard's data layer. GitHub calls go straight from the page (no server).
// The auto-save timer only runs while a dashboard tab is open; edits made before closing are kept
// in localStorage and saved the next time the page opens.
import * as store from "../../extension/src/lib/store.js";
import { storage } from "../../extension/src/lib/platform.js";
import { createOutbox } from "./outbox.js";

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
  return { ghOwner: s.ghOwner || "", ghRepo: s.ghRepo || "", ghBranch: s.ghBranch || "main", hasToken: !!s.ghToken, hasAnthropicKey: !!s.anthropicKey };
}

/** Blank secret fields keep the saved value; `forget` lists secrets to delete. */
async function saveConnection({ settings, forget = [] }) {
  const patch = {};
  for (const k of ["ghOwner", "ghRepo", "ghBranch"]) if (k in settings) patch[k] = String(settings[k]).trim();
  for (const k of ["ghToken", "anthropicKey"]) if (settings[k]?.trim()) patch[k] = settings[k].trim();
  for (const k of forget) patch[k] = "";
  await store.saveSettings(patch);
  return getConnection();
}

const handlers = {
  getConnection,
  saveConnection,
  testConnection: () => store.testConnection(),
  getStatus: () => store.getStatus(),
  initDataRepo: () => store.initDataRepo(),
  listAccounts: () => store.listAccounts(),
  upsertAccount: ({ account }) => store.upsertAccount(account),
  getAllTransactions: () => store.getAllTransactions(),
  getCategories: () => store.getCategories(),
  queueEdit: ({ op }) => getOutbox().queue(op),
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

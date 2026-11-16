// Service worker: owns all GitHub I/O so saves survive the popup closing.
// (The dashboard is a separate web app in web/, not part of the extension.)
import * as store from "./lib/store.js";

const handlers = {
  testConnection: () => store.testConnection(),
  getStatus: () => store.getStatus(),
  initDataRepo: () => store.initDataRepo(),
  listAccounts: () => store.listAccounts(),
  getTransactions: ({ accountId, years }) => store.getTransactions(accountId, years),
  commitImport: ({ plan }) => saveTracked(() => store.commitImport(plan), plan),
};

/** Records the outcome of a save where the popup/dashboard can find it, and badges the toolbar icon. */
async function saveTracked(fn, plan) {
  try {
    const r = await fn();
    await chrome.storage.local.set({ lastSave: { ok: true, at: new Date().toISOString(), accountId: plan.accountId, added: plan.add.length, ...r } });
    await chrome.action.setBadgeText({ text: "" });
    return r;
  } catch (e) {
    await chrome.storage.local.set({ lastSave: { ok: false, at: new Date().toISOString(), accountId: plan.accountId, error: e.message || String(e) } });
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    await chrome.action.setBadgeText({ text: "!" });
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // async response
});

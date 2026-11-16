import { call, fmtMoney, fmtDate, el, slug, accountBadge } from "../lib/ui.js";
import { reconcile } from "../lib/reconcile.js";

const $ = (id) => document.getElementById(id);
const EXTRACT_FILES = [
  "src/content/common.js",
  "src/content/extractors/generic.js",
  "src/content/extractors/wellsfargo.js",
  "src/content/run-extract.js",
];

let tab, extraction, accounts = [], plan = null;
// how the target account was decided: "existing" | "new" (both auto-detected) | "manual" (no last4 on page)
let target = { mode: null, account: null };

const status = (msg, cls = "") => { $("status").className = `status ${cls}`; $("status").textContent = msg; };

init().catch((e) => status(e.message, "bad"));

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("pageInfo").textContent = tab?.url ? new URL(tab.url).hostname : "";
  $("openOptions").onclick = () => chrome.runtime.openOptionsPage();
  $("extract").onclick = () => run(extract);
  $("capture").onclick = () => run(capture);
  $("save").onclick = () => run(save);

  const { settings, lastSave } = await chrome.storage.local.get(["settings", "lastSave"]);
  if (!settings?.ghToken) { $("notConfigured").hidden = false; return; }

  // a save can fail after the popup closed; surface it here (badge shows "!")
  if (lastSave && !lastSave.ok) {
    $("lastSaveError").hidden = false;
    $("lastSaveError").textContent = `Last save FAILED (${new Date(lastSave.at).toLocaleString()}): ${lastSave.error}`;
    await chrome.action.setBadgeText({ text: "" });
  }

  // restore the last extraction (popup closes whenever focus leaves it). Some banks use one URL
  // for every account, so it's labeled — and the save is still checked against the page's last4.
  const { lastExtraction } = await chrome.storage.session.get("lastExtraction");
  if (lastExtraction && tab?.url?.startsWith(lastExtraction.url)) {
    extraction = lastExtraction;
    await showExtraction();
    const mins = Math.round((Date.now() - Date.parse(extraction.extractedAt)) / 60000);
    status(`Restored extraction from ${mins} min ago (…${extraction.account?.last4 || "?"}). Re-extract if you've switched accounts.`, "warn");
  }
}

async function run(fn) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try { await fn(); } catch (e) { status(e.message, "bad"); console.error(e); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

async function extract() {
  status("Reading page…");
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: EXTRACT_FILES });
  const frames = results.map((r) => r.result).filter((r) => r && r.ok);
  const failed = results.map((r) => r.result).find((r) => r && !r.ok);
  if (!frames.length) throw new Error(failed?.error || "Extraction returned nothing.");
  extraction = frames.sort((a, b) => b.transactions.length - a.transactions.length)[0];
  await chrome.storage.session.set({ lastExtraction: extraction });
  await showExtraction();
  status("");
}

async function showExtraction() {
  $("result").hidden = false;
  clearPlan();
  const x = extraction;
  $("summary").innerHTML = "";
  $("summary").append(
    el("b", {}, `${x.transactions.length} transactions`),
    el("span", { class: "muted" }, ` via ${x.extractorId}`),
    x.balanceCents != null ? el("span", { class: "muted" }, ` · ${x.balanceLabel || "balance"} ${fmtMoney(x.balanceCents)}`) : "",
  );
  $("warnings").textContent = (x.warnings || []).join(" ");
  accounts = await call("listAccounts");
  detectAccount();
  if (target.mode !== "manual") await compare(); // the account is known: compare right away
}

/** Picks the account from the page itself (institution + last 4). Never defaults to some other account. */
function detectAccount() {
  const x = extraction;
  const last4 = x.account?.last4;
  const box = $("accountBox");
  box.innerHTML = "";

  if (x.institution && last4) {
    const match = accounts.find((a) => a.institution === x.institution && a.last4 === last4);
    if (match) {
      target = { mode: "existing", account: match };
      box.append(el("div", { class: "row" }, "Account: ", accountBadge(match), el("b", {}, match.name), el("span", { class: "muted" }, "(detected from page)")));
      return;
    }
    const type = x.account.type || "checking";
    target = { mode: "new", account: { id: slug(`${x.institution}-${type}-${last4}`), institution: x.institution, type, name: (x.account.name || `${x.institution} ${type}`).slice(0, 50), last4, isNew: true } };
    box.append(el("div", { class: "row" },
      "New account ", accountBadge(target.account), " will be created:",
      el("input", { id: "naName", value: target.account.name, size: 34, title: "Display name" }),
      el("span", { class: "muted" }, type),
    ));
    return;
  }

  // Page didn't show an account number: the user must choose explicitly (no default).
  target = { mode: "manual", account: null };
  const sel = el("select", { id: "accountSelect" },
    el("option", { value: "" }, "Choose account…"),
    accounts.map((a) => el("option", { value: a.id }, `${a.name} …${a.last4 || "?"}`)),
    el("option", { value: "__new" }, "+ New account…"),
  );
  const fields = el("div", { id: "newAccount", class: "row", hidden: true },
    el("input", { id: "naInstitution", placeholder: "institution", size: 10, value: x.institution || "" }),
    el("select", { id: "naType" }, ["checking", "savings", "credit_card"].map((t) => el("option", { value: t }, t))),
    el("input", { id: "naName", placeholder: "display name", size: 22 }),
    el("input", { id: "naLast4", placeholder: "last 4", size: 5 }),
  );
  // compare as soon as the account is chosen (for a new account, once its fields are valid)
  const tryCompare = () => { clearPlan(); try { resolveAccount(); } catch (_) { return; } run(compare); };
  sel.onchange = () => { fields.hidden = sel.value !== "__new"; tryCompare(); };
  fields.onchange = tryCompare;
  box.append(el("div", { class: "warn" }, "Couldn't read an account number on this page. Choose the account carefully."), el("div", { class: "row" }, "Account: ", sel), fields);
}

function resolveAccount() {
  if (target.mode === "existing") return target.account;
  if (target.mode === "new") {
    const name = $("naName").value.trim() || target.account.name;
    return { ...target.account, name };
  }
  const v = $("accountSelect").value;
  if (!v) throw new Error("Choose which account these transactions belong to.");
  if (v !== "__new") return accounts.find((a) => a.id === v);
  const institution = slug($("naInstitution").value);
  const type = $("naType").value;
  const last4 = $("naLast4").value.trim();
  const name = $("naName").value.trim() || `${institution} ${type}`;
  if (!institution) throw new Error("Institution is required for a new account.");
  if (last4 && !/^\d{4}$/.test(last4)) throw new Error("Last 4 must be 4 digits.");
  return { id: slug(`${institution}-${type}-${last4 || name}`), institution, type, name, last4: last4 || null, isNew: true };
}

function clearPlan() {
  plan = null;
  $("preview").innerHTML = "";
  $("save").hidden = true;
}

async function compare() {
  status("Loading saved transactions…");
  const account = resolveAccount();
  const incoming = extraction.transactions;
  if (!incoming.length) throw new Error("Nothing to compare.");
  const years = [...new Set(incoming.map((t) => t.date.slice(0, 4)))];
  // include previous year so Dec-pending → Jan-posted matches
  years.push(String(Math.min(...years.map(Number)) - 1));
  const existing = account.isNew ? [] : await call("getTransactions", { accountId: account.id, years });
  const r = reconcile(existing, incoming);
  plan = { account, ...r, years };
  renderPlan();
  status(`${r.add.length} new · ${r.updates.length} updated · ${r.duplicates.length} already saved · ${r.stalePending.length} stale pending`);
}

function renderPlan() {
  const rows = [
    ...plan.add.map((t) => ({ cls: "new", label: "new", t })),
    ...plan.updates.map((u) => ({ cls: "upd", label: "update", t: u.incoming, title: `was ${u.existing.status} ${fmtDate(u.existing.date)} ${fmtMoney(u.existing.amountCents)}` })),
    ...plan.stalePending.map((t, i) => ({ cls: "stale", t, staleIdx: i })),
    ...plan.duplicates.map((d) => ({ cls: "dup", label: "saved", t: d.incoming })),
  ];
  const table = el("table", { class: "dense" },
    el("colgroup", {}, el("col", { style: "width:110px" }), el("col", { style: "width:92px" }), el("col"), el("col", { style: "width:100px" })),
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Date"), el("th", {}, "Description"), el("th", { class: "num" }, "Amount"))),
    el("tbody", {}, rows.map((r) => el("tr", { class: r.cls, title: r.title || "" },
      el("td", {}, r.cls === "stale"
        ? el("label", { class: "row", style: "margin:0", title: "Pending charge no longer on the page (voided, or posted at a different amount)" }, el("input", { type: "checkbox", checked: true, "data-stale": r.staleIdx }), "remove stale")
        : el("span", { class: "pill" }, r.label)),
      el("td", {}, fmtDate(r.t.date)),
      el("td", { title: r.t.description }, r.t.description),
      el("td", { class: `num ${r.t.amountCents < 0 ? "" : "good"}` }, fmtMoney(r.t.amountCents)),
    ))),
  );
  $("preview").innerHTML = "";
  $("preview").append(table);
  const changes = plan.add.length + plan.updates.length + plan.stalePending.length;
  $("save").hidden = changes === 0;
  $("save").textContent = `Save ${plan.add.length} new, ${plan.updates.length} updates to …${plan.account.last4 || plan.account.name}`;
}

async function save() {
  if (!plan) return;
  const removeIds = [...document.querySelectorAll("input[data-stale]")]
    .filter((c) => c.checked)
    .map((c) => plan.stalePending[+c.dataset.stale].id);
  status("Saving to GitHub…");
  const { isNew, ...account } = plan.account;
  const touched = [...plan.updates.map((u) => u.existing), ...plan.stalePending.filter((t) => removeIds.includes(t.id))];
  const result = await call("commitImport", {
    plan: {
      accountId: account.id,
      newAccount: isNew ? account : null,
      // server re-checks this against the target account's last4 (guards against cross-account saves)
      detectedLast4: extraction.account?.last4 || null,
      add: plan.add,
      updates: plan.updates.map((u) => ({ existingId: u.existing.id, incoming: u.incoming })),
      removeIds,
      touchYears: [...new Set(touched.map((t) => t.date.slice(0, 4)))],
      duplicateCount: plan.duplicates.length,
      balanceCents: extraction.balanceCents ?? null,
      meta: { extractorId: extraction.extractorId, method: extraction.method, url: extraction.url, extractedAt: extraction.extractedAt },
    },
  });
  const summary = `Saved ${plan.add.length} new, ${plan.updates.length} updated to ${account.name} …${account.last4 || ""} (commit ${result.sha.slice(0, 7)}).`;
  clearPlan(); // sets plan = null, so build the message first
  await chrome.storage.session.remove("lastExtraction");
  status(summary, "good");
}

async function capture() {
  status("Capturing page structure…");
  const redact = $("redact").checked;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (r) => { globalThis.FD_SNAPSHOT_OPTS = { redact: r }; }, args: [redact] });
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/snapshot.js"] });
  const snap = res?.result;
  if (!snap?.ok) throw new Error("Capture failed.");
  const host = snap.host.replace(/^www\.|^connect\.secure\./, "").split(".")[0];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const url = URL.createObjectURL(new Blob([snap.html], { type: "text/html" }));
  const a = el("a", { href: url, download: `fd-capture-${host}-${stamp}.html` });
  document.body.append(a);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Captured ${snap.elementCount} elements (${Math.round(snap.html.length / 1024)} KB)${snap.truncated ? " — TRUNCATED" : ""}. Check your Downloads folder.`, "good");
}

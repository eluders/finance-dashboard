// Drives the real web dashboard (web/index.html + dashboard.js) in jsdom: no extension APIs, just
// localStorage and fetch, wired to the real store + outbox over a fake GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { fakeGitHub } from "./helpers/fake-github.mjs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: "https://someone.github.io/finance-dashboard/" });
const { window } = dom;
Object.assign(globalThis, { document: window.document, window, Option: window.Option, Event: window.Event, localStorage: window.localStorage, location: window.location, history: window.history });
delete globalThis.chrome;
// the page's 1s save-status ticker and 60s auto-save timer must not keep the test process alive
const realSetInterval = globalThis.setInterval, realSetTimeout = globalThis.setTimeout;
globalThis.setInterval = (fn, ms) => realSetInterval(fn, ms).unref();
globalThis.setTimeout = (fn, ms) => { const t = realSetTimeout(fn, ms); if (ms > 1000) t.unref(); return t; };

const gh = fakeGitHub();
globalThis.fetch = gh.fetch;
localStorage.setItem("fd:settings", JSON.stringify({ ghOwner: "me", ghRepo: "finance-data", ghBranch: "main", ghToken: "t" }));
const outboxNow = () => JSON.parse(localStorage.getItem("fd:outbox") || "{}");

const store = await import("../extension/src/lib/store.js");
const acct = { id: "wf-card-4242", institution: "wellsfargo", type: "credit_card", name: "Active Cash", last4: "4242" };
await store.commitImport({
  accountId: acct.id, newAccount: acct, updates: [], removeIds: [], meta: {},
  add: [
    { date: "2026-11-13", amountCents: -8000, description: "SAFEWAY #1439 SANTA CLARA CA", status: "posted" },
    { date: "2026-11-10", amountCents: -1299, description: "NETFLIX.COM", status: "posted" },
  ],
});

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5)); };
const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true }));
const rowOf = (text) => $$("tr.tx").find((r) => r.textContent.includes(text));
const onGitHub = async (text) => (await store.getAllTransactions()).find((t) => t.description.includes(text));
const pending = () => Object.keys(outboxNow().tx || {}).length + (outboxNow().categories ? 1 : 0);

await import("../web/dashboard.js");
await settle();
const commitsAtStart = gh.log().length;

const go = async (hash) => { window.location.hash = hash; await settle(); };
const sumRow = (label) => $$("#summaryBody tr").find((r) => r.querySelector("td.label")?.textContent === label);
const sumCells = (label) => [...sumRow(label).children].slice(1).map((td) => td.textContent);
const button = (scope, text) => [...$$(`${scope} button`)].find((b) => b.textContent === text);

test("tabs: opens on Summary; Transactions and Settings are separate pages", async () => {
  assert.equal($("#tab-summary").hidden, false);
  assert.equal($("#tab-transactions").hidden, true);
  assert.ok($(".tabs a.active").textContent === "Summary");
  await go("#transactions");
  assert.equal($("#tab-summary").hidden, true);
  assert.equal($("#tab-transactions").hidden, false);
  assert.ok($(".tabs a.active").textContent === "Transactions");
});

test("table: column order, MM-DD-YYYY, account badge, faint Uncategorized", () => {
  assert.deepEqual($$("#txns thead th").map((th) => th.textContent), ["Account", "Date", "Description", "Amount", "Note", "Category"]);
  const cells = [...rowOf("SAFEWAY").children].map((td) => td.textContent.trim());
  assert.equal(cells[0], "…4242");
  assert.equal(cells[1], "11-13-2026");
  assert.equal(cells[3], "-$80.00");
  assert.ok(rowOf("NETFLIX").querySelector("select").classList.contains("uncat"));
});

test("category + note edits are instant and local: nothing is committed yet", async () => {
  const sel = rowOf("NETFLIX").querySelector("select");
  sel.value = "subscriptions";
  fire(sel, "change");
  assert.ok(!sel.classList.contains("uncat"), "turns normal immediately");
  const note = rowOf("NETFLIX").querySelector("input.cell-input");
  note.value = "family plan";
  fire(note, "change");
  await settle();
  assert.equal(pending(), 1, "both edits coalesce into one outbox entry");
  assert.equal(gh.log().length, commitsAtStart, "no GitHub commit yet");
  assert.equal((await onGitHub("NETFLIX")).category, null);
  assert.match($("#saveState").textContent, /1 unsaved change · auto-save in (1:00|0:[0-5]\d)/);
  assert.equal($("#saveNow").disabled, false);
});

test("closing the tab with unsaved changes asks for confirmation AND starts saving immediately", async () => {
  const ev = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  await settle();
  assert.equal(pending(), 0);
  assert.equal(gh.log().length, commitsAtStart + 1);
  assert.equal((await onGitHub("NETFLIX")).note, "family plan");
});

test("split with a Remaining row: only one remainder, live math, applied locally", async () => {
  rowOf("SAFEWAY").children[2].click(); // expand
  $("tr.detail button").click(); // "Split transaction…"
  const rows = () => $$("tr.detail .split-table tr");
  assert.equal(rows().length, 2);
  assert.ok(rows()[1].querySelector(".rem-toggle.on"), "second row starts as Remaining");

  const amt = rows()[0].querySelector(".split-amount");
  amt.value = "12.50"; fire(amt, "input");
  assert.equal(rows()[1].querySelector(".rem-amount").textContent, "67.50");
  rows()[0].querySelector(".split-select").value = "health"; fire(rows()[0].querySelector(".split-select"), "change");
  rows()[1].querySelector(".split-select").value = "groceries"; fire(rows()[1].querySelector(".split-select"), "change");

  button("tr.detail", "+ Add row").click();
  rows()[2].querySelector(".rem-toggle").click();
  assert.equal($$("tr.detail .rem-toggle.on").length, 1);
  const a2 = rows()[1].querySelector(".split-amount");
  a2.value = "70"; fire(a2, "input");
  assert.equal(button("tr.detail", "Save split").disabled, true);
  assert.match($("tr.detail .split-summary").textContent, /more than/);
  a2.value = "60"; fire(a2, "input");
  assert.equal(rows()[2].querySelector(".rem-amount").textContent, "7.50");
  button("tr.detail", "Save split").click();
  assert.match(rowOf("SAFEWAY").textContent, /Split · 3/, "instant");
  await settle();
  assert.equal(pending(), 1);
  assert.equal(gh.log().length, commitsAtStart + 1, "split not pushed yet");
});

test("summary: per-category monthly sums (split parts counted separately), group + subtotal rows", async () => {
  await go("#summary");
  assert.deepEqual($$("#summaryBody thead th").map((th) => th.textContent), ["Category", "Nov", "Total", "Avg / mo"], "only months with data");
  assert.deepEqual(sumCells("Subscriptions"), ["$13", "$13", "$13"]);
  assert.deepEqual(sumCells("Groceries"), ["$60", "$60", "$60"]);
  assert.deepEqual(sumCells("Health & Medical"), ["$13", "$13", "$13"]); // the $12.50 split part
  assert.equal(sumRow("Food").classList.contains("group-row"), true);
  assert.deepEqual(sumCells("Food"), ["$60", "$60", "$60"]);
  assert.deepEqual(sumCells("Subtotal"), ["$85", "$85", "$85"]); // 12.99 + 12.50 + 60 = 85.49
  assert.deepEqual(sumCells("Uncategorized"), ["$8", "$8", "$8"]); // the $7.50 remainder has no category
  assert.equal(sumCells("Travel").join(""), "", "unused categories are listed, blank");
});

test("summary: clicking a cell opens Transactions filtered to that category and month", async () => {
  sumRow("Groceries").children[1].click();
  await settle();
  assert.equal($("#tab-transactions").hidden, false);
  assert.equal($("#filterCategory").value, "groceries");
  assert.equal($("#filterDate").value, "2026-11");
  assert.deepEqual($$("tr.tx").map((r) => r.children[2].textContent), ["SAFEWAY #1439 SANTA CLARA CA"], "split part matches");
  $("#filterCategory").value = ""; fire($("#filterCategory"), "change");
  $("#filterDate").value = ""; fire($("#filterDate"), "change");
  assert.equal($$("tr.tx").length, 2);
});

// jsdom has no layout (every rect is 0x0), so clientY -1 = "above everything", +1 = "below everything"
function dragTo(handle, target, clientY) {
  const item = handle.closest(".cat-row, .cat-group");
  fire(handle, "pointerdown");
  assert.equal(item.draggable, true, "only the handle makes the row draggable");
  fire(item, "dragstart");
  target.dispatchEvent(new window.MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
  fire(item, "dragend");
}

test("Edit categories (on Summary): drag handles reorder groups and move categories between groups", async () => {
  await go("#summary");
  $("#editCategories").click();
  assert.equal($("#editCategories").hidden, true);
  const groups = () => $$("#summaryBody .cat-group");
  const names = (g) => [...g.querySelectorAll(".cat-row input")].map((i) => i.value);
  assert.equal($$("#summaryBody select").length, 0, "no move-to-group dropdown");
  assert.ok(!$("#summaryBody").textContent.match(/[▲▼]/), "no arrow buttons");
  assert.ok(groups().every((g) => g.querySelector(".drag-handle").textContent === "☰"));

  // drag the first group to the bottom
  const firstGroupName = groups()[0].querySelector(".cat-group-name").value;
  dragTo(groups()[0].querySelector(":scope > .row .drag-handle"), $("#summaryBody .cat-groups"), 1);
  assert.equal(groups().at(-1).querySelector(".cat-group-name").value, firstGroupName);

  // drag "Subscriptions" to the top of the first group: its group follows where it was dropped
  const subs = $$("#summaryBody .cat-row").find((r) => r.querySelector("input").value === "Subscriptions");
  dragTo(subs.querySelector(".drag-handle"), groups()[0].querySelector(".cat-list"), -1);
  assert.equal(names(groups()[0])[0], "Subscriptions");
  assert.equal($$("#summaryBody .cat-row input").filter((i) => i.value === "Subscriptions").length, 1, "moved, not copied");

  [...groups()[0].querySelectorAll("button")].find((b) => b.textContent === "+ Category").click();
  const inputs = groups()[0].querySelectorAll(".cat-row input");
  inputs[inputs.length - 1].value = "Pharmacy";
  fire(inputs[inputs.length - 1], "input");
  const subsRow = $$("#summaryBody .cat-row").find((r) => r.querySelector("input").value === "Subscriptions");
  assert.equal(subsRow.querySelector("button[title^='Used by']").disabled, true, "in-use category can't be deleted");

  // a section break before the 4th group splits the summary into two blocks with their own subtotals
  [...groups()[3].querySelectorAll("button")].find((b) => b.textContent === "Section break").click();
  assert.ok(groups()[3].classList.contains("section-start"));

  button("#summaryBody", "Save categories").click();
  assert.equal($("#editCategories").hidden, false, "back to the summary");
  assert.equal($$("#summaryBody tr.subtotal-row").length, 2);
  assert.equal(sumRow("Pharmacy") != null, true);
  await settle();
  assert.equal(pending(), 2);
  await go("#transactions");
  assert.ok([...rowOf("NETFLIX").querySelectorAll("option")].some((o) => o.textContent === "Pharmacy"), "row dropdowns updated instantly");
});

test("Cancel in the category editor throws the draft away", async () => {
  await go("#summary");
  $("#editCategories").click();
  $("#summaryBody .cat-group-name").value = "Renamed"; fire($("#summaryBody .cat-group-name"), "input");
  assert.equal($("#catDirty").textContent, "Unsaved changes");
  button("#summaryBody", "Cancel").click();
  assert.equal(sumRow("Renamed"), undefined);
  assert.equal(pending(), 2, "nothing new queued");
});

test("Save now pushes everything as ONE commit, then shows saved", async () => {
  $("#saveNow").click();
  await settle();
  assert.equal(gh.log().length, commitsAtStart + 2);
  assert.match(gh.log()[0], /1 transaction edit \+ categories/);
  const nf = await onGitHub("NETFLIX");
  assert.equal(nf.category, "subscriptions");
  assert.equal(nf.note, "family plan");
  const sw = await onGitHub("SAFEWAY");
  assert.deepEqual(sw.splits.map((s) => [s.amountCents, s.category, !!s.remainder]), [[-1250, "health", false], [-6000, "groceries", false], [-750, null, true]]);
  const saved = await store.getCategories();
  assert.ok(saved.groups[0].categories.some((c) => c.name === "Pharmacy"));
  assert.equal(saved.groups[0].categories[0].name, "Subscriptions", "group membership saved from the drop position");
  assert.equal(saved.groups[3].sectionBreak, true);
  assert.equal(pending(), 0);
  assert.match($("#saveState").textContent, /All changes saved/);
  assert.equal($("#saveNow").disabled, true);
  const ev = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, "no warning once saved");
});

test("unsaved edits survive a reload (overlaid from the outbox)", async () => {
  await go("#transactions");
  const sel = rowOf("NETFLIX").querySelector("select");
  sel.value = "entertainment"; fire(sel, "change");
  await settle();
  $("#reload").click();
  await settle();
  assert.equal(rowOf("NETFLIX").querySelector("select").value, "entertainment", "still shown after reload, before saving");
  assert.equal((await onGitHub("NETFLIX")).category, "subscriptions");
});

test("Settings tab: connection (token never shown back, can be forgotten) and account colors", async () => {
  await go("#settings");
  assert.equal($("#sOwner").value, "me");
  assert.equal($("#sToken").value, "", "secret not echoed into the page");
  assert.match($("#sToken").placeholder, /saved/);
  assert.ok($("#accountPanel input[type=color]"), "account colors live in Settings");
  assert.equal($("#accountPanel .acct").textContent, "…4242");
  button("#settingsPanel", "Forget token").click();
  await settle();
  assert.equal(JSON.parse(localStorage.getItem("fd:settings")).ghToken, "");
});

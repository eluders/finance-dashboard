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
// GitHub goes to the fake repo; api.anthropic.com to a fake Claude that streams `claude.reply`
const claude = { reply: "", requests: [] };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://api.anthropic.com/")) return gh.fetch(url, opts);
  claude.requests.push(JSON.parse(opts.body));
  const ev = (e) => `event: ${e.type}
data: ${JSON.stringify(e)}

`;
  return new Response([
    ev({ type: "message_start", message: { usage: { input_tokens: 900, output_tokens: 1 } } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: claude.reply } }),
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }),
  ].join(""), { status: 200 });
};
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
const pending = () => Object.keys(outboxNow().tx || {}).length + (outboxNow().categories ? 1 : 0) + (outboxNow().budget ? 1 : 0);

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
  button("tr.detail", "Split transaction…").click();
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
  assert.deepEqual($$("#summaryBody thead th").map((th) => th.textContent), ["Category", "Nov", "Total", "Avg / mo", "Predicted / mo"], "only months with data");
  assert.deepEqual(sumCells("Subscriptions"), ["$13", "$13", "$13", ""]);
  assert.deepEqual(sumCells("Groceries"), ["$60", "$60", "$60", ""]);
  assert.deepEqual(sumCells("Health & Medical"), ["$13", "$13", "$13", ""]); // the $12.50 split part
  assert.equal(sumRow("Food").classList.contains("group-row"), true);
  assert.deepEqual(sumCells("Food"), ["$60", "$60", "$60", ""]);
  assert.deepEqual(sumCells("Subtotal"), ["$85", "$85", "$85", ""]); // 12.99 + 12.50 + 60 = 85.49
  assert.deepEqual(sumCells("Uncategorized"), ["$8", "$8", "$8", ""]); // the $7.50 remainder has no category
  assert.equal(sumCells("Travel").join(""), "", "unused categories are listed, blank");
});

test("summary: clicking a cell opens Transactions filtered to that category and month", async () => {
  sumRow("Groceries").children[1].click();
  await settle();
  assert.equal($("#tab-transactions").hidden, false);
  const checked = $$("#filterCategory input[data-id]").filter((c) => c.checked).map((c) => c.dataset.id);
  assert.deepEqual(checked, ["groceries"]);
  assert.match($("#filterCategory summary").textContent, /Categories: Groceries/);
  assert.equal($("#filterDate").value, "2026-11");
  assert.deepEqual($$("tr.tx").map((r) => r.children[2].textContent), ["SAFEWAY #1439 SANTA CLARA CA"], "split part matches");
  button("#filterCategory", "All but Archive").click();
  $("#filterDate").value = ""; fire($("#filterDate"), "change");
  assert.equal($$("tr.tx").length, 2);
});

test("category filter: bold group boxes select a whole group; custom date range", async () => {
  const groupBox = $$("#filterCategory label.cb.group").find((l) => l.textContent === "Food").querySelector("input");
  button("#filterCategory", "None").click();
  assert.equal($$("tr.tx").length, 0);
  groupBox.checked = true; fire(groupBox, "change");
  assert.deepEqual($$("#filterCategory input[data-id]").filter((c) => c.checked).map((c) => c.dataset.id), ["groceries", "dining"]);
  assert.equal($$("tr.tx").length, 1, "SAFEWAY (its groceries part)");
  button("#filterCategory", "All but Archive").click();
  $("#filterDate").value = "custom"; fire($("#filterDate"), "change");
  assert.equal($("#dateRange").hidden, false);
  $("#dateFrom").value = "2026-11-11"; fire($("#dateFrom"), "change");
  assert.deepEqual($$("tr.tx").map((r) => r.children[1].textContent), ["11-13-2026"]);
  $("#dateFrom").value = ""; $("#filterDate").value = ""; fire($("#filterDate"), "change");
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

test("counted-amount override from the expanded row: struck-through bank amount, summary counts the override", async () => {
  await go("#transactions");
  rowOf("NETFLIX").children[2].click(); // expand
  const detail = () => rowOf("NETFLIX").nextElementSibling;
  const btn = (text) => [...detail().querySelectorAll(".override-editor button")].find((b) => b.textContent === text);
  btn("Don't count ($0)").click();
  assert.match(rowOf("NETFLIX").children[3].textContent, /-\$12\.99\s+\$0\.00/);
  await go("#summary");
  assert.equal(sumRow("Entertainment").children[1].textContent, "", "not counted any more");
  await go("#transactions");
  detail().querySelector(".override-editor input").value = "5";
  btn("Set").click();
  assert.match(rowOf("NETFLIX").children[3].textContent, /-\$5\.00$/);
  btn("Use bank amount").click();
  assert.equal(rowOf("NETFLIX").children[3].textContent, "-$12.99");
  // a split transaction can't be zeroed until the split is removed (and nothing half-applies)
  const sw = rowOf("SAFEWAY").nextElementSibling;
  [...sw.querySelectorAll(".override-editor button")].find((b) => b.textContent === "Don't count ($0)").click();
  assert.match(rowOf("SAFEWAY").nextElementSibling.querySelector(".override-editor .bad").textContent, /can't be split/);
  assert.match(rowOf("SAFEWAY").textContent, /Split · 3/);
});

test("Archive: hidden from the list and the summary unless ticked in the category filter", async () => {
  await go("#transactions");
  const sel = rowOf("NETFLIX").querySelector("select");
  sel.value = "archive"; fire(sel, "change");
  fire($("#search"), "input"); // re-render the list
  assert.equal(rowOf("NETFLIX"), undefined, "hidden by default");
  assert.match($("#count").textContent, /1 archived hidden/);
  const arch = $("#filterCategory input[data-id='archive']");
  arch.checked = true; fire(arch, "change");
  assert.ok(rowOf("NETFLIX"), "shown when Archive is ticked");
  assert.ok(rowOf("NETFLIX").querySelector("select").classList.contains("archived"));
  await go("#summary");
  assert.equal(sumRow("Archive"), undefined);
  assert.equal(sumCells("Entertainment").join(""), "", "not counted anywhere");
});

test("AI categorize panel: scope = table rows → Claude → table review with After column → apply category + notes", async () => {
  await go("#settings");
  $("#sAnthropicKey").value = "sk-test";
  button("#aiSettingsPanel", "Save").click();
  await settle();
  assert.equal(JSON.parse(localStorage.getItem("fd:settings")).anthropicKey, "sk-test");
  assert.equal($("#sAnthropicKey").value, "", "key not shown back");
  assert.equal($("#sAiModel").value, "claude-haiku-5-5", "cheap model by default");

  await go("#transactions"); // Archive is still ticked from the previous test, so both rows show
  assert.equal($$("tr.tx").length, 2);
  $("#aiOpen").click();
  await settle();
  assert.ok(document.body.classList.contains("ai-open"));
  assert.equal($$("#aiPanel textarea").length, 2, "session notes + (collapsed) AI notes; no user notes");
  assert.equal($("#aiPanel details.notes-editor").open, false, "AI notes collapsed by default");
  assert.match($("#aiPanel .notes-editor textarea").value, /Categorization notes/);
  assert.match($("#aiPanel .ai-scope").textContent, /^0 transactions .* 1 split skipped · 1 already categorized skipped/);
  const only = [...$$("#aiPanel label.cb")].find((l) => /Only uncategorized/.test(l.textContent)).querySelector("input");
  only.checked = false; fire(only, "change");
  await settle();
  assert.match($("#aiPanel .ai-scope").textContent, /^1 transaction from the table/);
  $("#aiSession").value = "Netflix is a subscription, not archived. Streaming services are always Subscriptions."; fire($("#aiSession"), "input");

  claude.reply = 'SET subscriptions WHERE text "NETFLIX"  # streaming\nSET bogus WHERE ids 1\n\nNOTES:\n- Streaming services (Netflix etc.) are Subscriptions, never Archive.\n';
  $("#aiRun").click();
  await settle();
  const body = claude.requests.at(-1);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.match(body.messages[0].content, /NETFLIX\.COM/);
  assert.doesNotMatch(body.messages[0].content, /SAFEWAY #1439 SANTA CLARA CA\|/, "split transaction not sent");
  assert.match(body.messages[0].content, /My notes for this session:\nNetflix is a subscription/);
  assert.match(body.messages[0].content, /AI NOTES:\n# Categorization notes/);

  // review happens in the table: only affected rows, with an After column
  assert.ok(document.body.classList.contains("reviewing"));
  assert.equal($("#reviewBanner").hidden, false);
  assert.deepEqual($$("#txns thead th").map((th) => th.textContent).slice(-2), ["Before", "After (AI)"]);
  assert.deepEqual($$("tr.tx").map((r) => r.children[2].textContent), ["NETFLIX.COM"]);
  assert.equal(rowOf("NETFLIX").querySelector("td.after-col").textContent, "Subscriptions");
  const panelApply = () => [...$$("#aiPanel button")].find((b) => b.textContent.startsWith("Apply"));
  assert.equal(panelApply().textContent, "Apply 1 change + notes", "approve button at the top of the panel");
  assert.match($("#aiPanel .notes-diff").textContent, /\+ - Streaming services \(Netflix etc\.\) are Subscriptions/);
  assert.match($("#aiPanel").textContent, /1 line of the reply couldn't be used/);
  const after = rowOf("NETFLIX").querySelector("td.after-col input");
  after.checked = false; fire(after, "change");
  await settle();
  assert.equal(panelApply().textContent, "Apply 0 changes + notes");
  rowOf("NETFLIX").querySelector("td.after-col input").checked = true; fire(rowOf("NETFLIX").querySelector("td.after-col input"), "change");
  await settle();
  assert.equal($("#aiSession"), null, "panel shows the review, not the form");

  panelApply().click();
  await settle();
  assert.ok(!document.body.classList.contains("reviewing"), "back to the normal table");
  const r = rowOf("NETFLIX");
  assert.equal(r.querySelector("select").value, "subscriptions");
  assert.equal(r.querySelector("input.cell-input").value, "family plan", "note untouched");
  assert.match(gh.files().get("ai-notes.md"), /Streaming services \(Netflix etc\.\) are Subscriptions/, "AI notes grew");
  assert.equal($("#aiSession").value, "", "session notes cleared after the run");

  await go("#logs");
  const card = $("#logsList .ai-run");
  assert.match(card.querySelector(".pill").textContent, /applied/);
  assert.match(card.textContent, /AI notes saved/);
});

test("one-time only: the AI isn't asked to remember, and NOTES in the reply are ignored", async () => {
  await go("#transactions");
  $("#aiOpen").click(); // (already open: no-op)
  await settle();
  const oneTime = $("#aiOneTime");
  oneTime.checked = true; fire(oneTime, "change");
  $("#aiSession").value = "Archive everything before 2026-11-12."; fire($("#aiSession"), "input");
  claude.reply = 'SET archive WHERE dates 2000-01-01..2026-11-11\nNOTES:\n- archive old stuff\n';
  $("#aiRun").click();
  await settle();
  const body = claude.requests.at(-1);
  assert.match(body.system, /one-time only: do NOT write NOTES/);
  assert.match(body.messages[0].content, /My notes for this session \(one-time only, don't remember them\)/);
  assert.equal($("#aiPanel .notes-change"), null, "no notes update offered");
  assert.equal([...$$("#aiPanel button")].find((b) => b.textContent.startsWith("Apply")).textContent, "Apply 1 change");
  [...$$("#aiPanel button")].find((b) => b.textContent === "Discard").click();
  await settle();
  assert.equal(rowOf("NETFLIX").querySelector("select").value, "subscriptions", "discarded: nothing changed");
  oneTime.checked = false;
  const o2 = $("#aiOneTime"); o2.checked = false; fire(o2, "change");
});

test("Notes only: nothing from the table is sent; the reply becomes a notes update to approve", async () => {
  await go("#transactions");
  await settle();
  const cb = $("#aiNotesOnly");
  cb.checked = true; fire(cb, "change");
  await settle();
  assert.equal($("#aiPanel .ai-scope"), null, "no scope / category picker in notes-only mode");
  assert.equal($("#aiPanel .cat-picker"), null);
  assert.equal($("#aiRun").textContent, "Update notes");
  assert.equal($("#aiRun").disabled, true, "needs something to remember");
  $("#aiSession").value = "Venmo to my mom is Hangout with family."; fire($("#aiSession"), "input");
  assert.equal($("#aiRun").disabled, false);

  const before = gh.files().get("ai-notes.md");
  claude.reply = "```\n" + before.trim() + "\n- Venmo to mom: Hangout with family.\n```";
  $("#aiRun").click();
  await settle();
  const body = claude.requests.at(-1);
  assert.match(body.system, /Merge it into the current notes/);
  assert.doesNotMatch(body.messages[0].content, /NETFLIX|SAFEWAY|COFFEE/, "no transactions sent");
  assert.match(body.messages[0].content, /What I want you to remember:\nVenmo to my mom/);

  assert.ok(!document.body.classList.contains("reviewing"), "the table isn't put into review mode");
  assert.equal($("#reviewBanner").hidden, true, "table unchanged");
  assert.deepEqual([...$$("#aiPanel .notes-diff .add")].map((d) => d.textContent), ["+ - Venmo to mom: Hangout with family."], "code fences stripped; only the new line is added");
  const apply = [...$$("#aiPanel button")].find((b) => b.textContent.startsWith("Apply"));
  assert.equal(apply.textContent, "Apply 0 changes + notes");
  apply.click();
  await settle();
  assert.match(gh.files().get("ai-notes.md"), /Venmo to mom: Hangout with family/);

  await go("#logs");
  assert.match($("#logsList .ai-run").textContent, /notes only/);
  await go("#transactions");
  await settle();
  const cb2 = $("#aiNotesOnly"); cb2.checked = false; fire(cb2, "change");
  await settle();
});

test("Logs: long results collapse to the first few rows, actions sit above them", async () => {
  const proposals = Array.from({ length: 8 }, (_, i) => ({ key: `x/${i}`, date: "2026-11-0" + (i + 1), description: `SHOP ${i}`, note: "", amountCents: -100 * (i + 1), from: null, to: "groceries", rule: 0, selected: true }));
  const runs = JSON.parse(localStorage.getItem("fd:aiRuns"));
  runs.unshift({ id: "big", at: new Date().toISOString(), status: "review", model: "claude-haiku-5-5", scope: { label: "all" }, instructions: "", txCount: 8, rules: [{ text: 'SET groceries WHERE text "SHOP"', category: "groceries", matched: 8 }], errors: [], proposals, usage: { input_tokens: 1, output_tokens: 1 }, cost: 0 });
  localStorage.setItem("fd:aiRuns", JSON.stringify(runs));
  await go("#summary"); await go("#logs");
  const card = $("#logsList .ai-run");
  assert.equal(card.querySelectorAll(".ai-table tr").length, 5);
  const apply = [...card.querySelectorAll("button")].find((b) => b.textContent === "Apply 8 changes");
  const table = card.querySelector(".ai-table");
  assert.ok(apply.compareDocumentPosition(table) & window.Node.DOCUMENT_POSITION_FOLLOWING, "Apply comes before the rows");
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Show all 8").click();
  await settle();
  assert.equal($("#logsList .ai-run").querySelectorAll(".ai-table tr").length, 8);
  [...$("#logsList .ai-run").querySelectorAll("button")].find((b) => b.textContent === "Discard").click();
  await settle();
});

test("Category column: blank strip + drag select; instant Ctrl+C / Ctrl+V with no bar; Undo; Delete; shift/ctrl-click", async () => {
  await store.commitImport({
    accountId: acct.id, updates: [], removeIds: [], meta: {},
    add: [
      { date: "2026-11-05", amountCents: -500, description: "COFFEE ONE", status: "posted" },
      { date: "2026-11-04", amountCents: -600, description: "COFFEE TWO", status: "posted" },
      { date: "2026-11-03", amountCents: -700, description: "COFFEE THREE", status: "posted" },
    ],
  });
  $("#reload").click();
  await settle();
  await go("#transactions");
  const cell = (text) => rowOf(text).querySelector("td.cat-cell");
  const mouse = (node, type, opts = {}) => node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...opts }));
  const key = (k, opts = {}) => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  const coffees = () => ["COFFEE ONE", "COFFEE TWO", "COFFEE THREE"].map((d) => rowOf(d).querySelector("select").value);

  // a plain click on the dropdown still opens it (focused) and selects that cell
  const down = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  cell("NETFLIX").querySelector("select").dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, "native dropdown held back until we know it isn't a drag");
  mouse(document.body, "mouseup");
  assert.equal(document.activeElement, cell("NETFLIX").querySelector("select"));
  key("c", { ctrlKey: true });
  assert.ok(cell("NETFLIX").classList.contains("copied"), "copied cell is outlined");

  // clicking the blank strip (the cell itself, not the dropdown) only selects
  mouse(cell("COFFEE ONE"), "mousedown"); mouse(document.body, "mouseup");
  assert.notEqual(document.activeElement?.tagName, "SELECT", "no dropdown from the blank strip");
  assert.equal($$("#txns td.cat-cell.selected").length, 1);

  // drag down the column, then paste: instant, no toolbar or prompt
  mouse(cell("COFFEE ONE"), "mousedown");
  mouse(cell("COFFEE TWO"), "mouseover");
  mouse(rowOf("COFFEE THREE").children[2], "mouseover"); // anywhere on the row counts
  mouse(document.body, "mouseup");
  assert.equal($$("#txns td.cat-cell.selected").length, 3);
  key("v", { ctrlKey: true });
  assert.deepEqual(coffees(), ["subscriptions", "subscriptions", "subscriptions"], "applied synchronously");
  assert.equal($("#selBar"), null, "no bar");
  assert.equal($$("#txns td.cat-cell.flash").length, 3, "changed cells flash");
  assert.equal($$("#txns td.cat-cell.selected").length, 3, "selection survives the paste");

  key("z", { ctrlKey: true });
  assert.deepEqual(coffees(), ["", "", ""], "Ctrl+Z undoes the paste");
  key("v", { ctrlKey: true });
  key("Delete");
  assert.deepEqual(coffees(), ["", "", ""]);
  assert.ok(rowOf("COFFEE ONE").querySelector("select").classList.contains("uncat"));

  // shift-click extends from the last clicked cell; split rows are skipped on paste
  mouse(cell("SAFEWAY"), "mousedown"); mouse(document.body, "mouseup");
  mouse(cell("COFFEE TWO"), "mousedown", { shiftKey: true });
  assert.equal($$("#txns td.cat-cell.selected").length, 4);
  key("v", { ctrlKey: true });
  assert.deepEqual(coffees(), ["subscriptions", "subscriptions", ""]);
  assert.match(rowOf("SAFEWAY").textContent, /Split · 3/, "split untouched");
  mouse(cell("NETFLIX"), "mousedown", { ctrlKey: true });
  assert.equal($$("#txns td.cat-cell.selected").length, 3, "ctrl-click toggles one cell");

  // clicking elsewhere clears the selection; Esc clears the copy too
  mouse($(".brand"), "mousedown");
  assert.equal($$("#txns td.cat-cell.selected").length, 0);
  key("Escape");
  assert.equal($$("#txns td.cat-cell.copied").length, 0);

  // the whole paste went to the outbox in one write
  await settle();
  const states = Object.values(outboxNow().tx).map((e) => e.state.category);
  assert.ok(states.filter((c) => c === "subscriptions").length >= 2);
});

test("Minimize/Maximize: editor columns with cross-side drag; summary toggle; Predict grid with monthly lock + one-offs", async () => {
  await go("#summary");
  if ($$("#sumMode button.on")[0]?.dataset.v !== "actual") button("#sumMode", "Actual").click();
  $("#editCategories").click();
  assert.equal($("#sumSide").hidden, true, "toggles hidden while editing");
  const col = (side) => $(`#summaryBody .cat-groups[data-side=${side}]`);
  assert.equal(col("maximize").querySelectorAll(".cat-group").length, 0);
  assert.match(col("maximize").textContent, /Drag groups here/);
  const groupWith = (catName) => $$("#summaryBody .cat-group").find((g) => [...g.querySelectorAll(".cat-row input")].some((i) => i.value === catName));
  const travelGroup = groupWith("Travel");
  const travelGroupName = travelGroup.querySelector(".cat-group-name").value;

  // drag the Travel group into the (empty) Maximize column, then drag Groceries into it too
  dragTo(travelGroup.querySelector(":scope > .row .drag-handle"), col("maximize"), 1);
  assert.equal(col("maximize").querySelectorAll(".cat-group").length, 1);
  const groceries = $$("#summaryBody .cat-row").find((r) => r.querySelector("input").value === "Groceries");
  dragTo(groceries.querySelector(".drag-handle"), col("maximize").querySelector(".cat-list"), 1);
  assert.equal(groupWith("Groceries"), groupWith("Travel"), "a category crosses sides into a group there");
  // and back: a category can cross from Maximize into a Minimize group
  const g2 = $$("#summaryBody .cat-row").find((r) => r.querySelector("input").value === "Groceries");
  dragTo(g2.querySelector(".drag-handle"), col("minimize").querySelector(".cat-group .cat-list"), -1);
  assert.ok(col("minimize").contains(groupWith("Groceries")));
  const g3 = $$("#summaryBody .cat-row").find((r) => r.querySelector("input").value === "Groceries");
  dragTo(g3.querySelector(".drag-handle"), col("maximize").querySelector(".cat-list"), 1);
  button("#summaryBody", "Save categories").click();

  // summary: Minimize shows everything but that group; Maximize shows only it
  assert.equal($("#sumSide").hidden, false);
  assert.equal(sumRow(travelGroupName), undefined, "on Minimize by default");
  button("#sumSide", "Maximize").click();
  assert.ok($("#sumSide button.on").textContent === "Maximize");
  assert.ok(sumRow(travelGroupName) && sumRow("Groceries"), "the Maximize side");
  assert.equal(sumRow("Subscriptions"), undefined);
  assert.equal(sumRow("Uncategorized"), undefined, "Uncategorized is a Minimize row");
  assert.ok(!sumRow("Groceries").children[1].classList.contains("good"), "Maximize shows sizes, not green 'money in'");

  // Predict: Monthly fills and locks all 12 months
  button("#sumMode", "Predict").click();
  assert.ok($("#summaryBody table.predict"));
  assert.equal($("#sumAccount").hidden, true, "predictions aren't per account");
  const year = $("#sumYear").value;
  const inputsOf = (label) => [...sumRow(label).querySelectorAll("input")];
  const [monthly, ...months] = inputsOf("Travel");
  assert.equal(months.length, 12);
  monthly.value = "100"; fire(monthly, "change");
  assert.ok(months.every((i) => i.value === "100" && i.readOnly), "filled and locked");
  const tds = (label) => [...sumRow(label).children].map((td) => td.textContent);
  assert.deepEqual(tds("Travel").slice(-2), ["$1,200", "$100"]);
  months[5].value = "5"; fire(months[5], "change");
  assert.equal(months[5].value, "100", "locked months can't be changed");

  // single months: a one-off spreads over the year
  const g = inputsOf("Groceries");
  g[6].value = "1,200"; fire(g[6], "change");
  g[7].value = "240.50"; fire(g[7], "change");
  assert.deepEqual(tds("Groceries").slice(-2), ["$1,441", "$120"]);
  assert.equal(g[1].readOnly, false);
  assert.deepEqual(tds(travelGroupName).slice(-2), ["$2,641", "$220"], "group row sums its categories");
  assert.ok(sumRow("Groceries").querySelector("td.pred") && $("#summaryBody .pred-input"), "predicted values use the orange class");
  g[8].value = "abc"; fire(g[8], "change");
  assert.equal(g[8].value, "", "bad input is put back");
  assert.match($("#status").textContent, /isn't an amount/);

  // clearing Monthly keeps the filled months, now editable
  monthly.value = ""; fire(monthly, "change");
  assert.ok(months.every((i) => i.value === "100" && !i.readOnly));
  months[0].value = "400"; fire(months[0], "change");
  assert.deepEqual(tds("Travel").slice(-2), ["$1,500", "$125"]);

  // Actual: a Predicted / mo column on the right, in orange
  button("#sumMode", "Actual").click();
  const last = sumRow("Groceries").lastElementChild;
  assert.equal(last.textContent, "$120");
  assert.ok(last.classList.contains("pred"));
  assert.equal(sumRow(travelGroupName).lastElementChild.textContent, "$245");

  // saved with everything else: one commit with budget.json
  await settle();
  assert.ok(outboxNow().budget, "buffered in the outbox");
  $("#saveNow").click();
  await settle();
  assert.match(gh.log()[0], /categories \+ budget/);
  const saved = JSON.parse(gh.files().get("budget.json"));
  assert.deepEqual(saved.years[year].travel, { months: [40000, ...Array(11).fill(10000)] });
  assert.deepEqual(saved.years[year].groceries.months.slice(5, 7), [120000, 24050]);
  const savedCats = await store.getCategories();
  assert.equal(savedCats.groups.find((x) => x.name === travelGroupName).side, "maximize");

  // reload: budget comes back from GitHub
  $("#reload").click();
  await settle();
  assert.equal(sumRow("Groceries").lastElementChild.textContent, "$120");
  button("#sumMode", "Predict").click();
  const gm = sumRow("Groceries").querySelector("input");
  gm.value = "50"; fire(gm, "change"); // left unsaved for the export test
  button("#sumMode", "Actual").click();
  assert.equal(sumRow("Groceries").lastElementChild.textContent, "$50");
  button("#sumSide", "Minimize").click();
});

test("financial year: Nov–Oct by default, named by the year it ends in; adjustable in Settings; group colors", async () => {
  await go("#summary");
  if (!$("#sumMode button.on") || $("#sumMode button.on").dataset.v !== "actual") button("#sumMode", "Actual").click();
  $("#sumYear").value = "2027"; fire($("#sumYear"), "change");
  assert.equal($("#sumRange").textContent, "Nov 2026 – Oct 2027", "Nov 2026 transactions belong to 2027");
  assert.equal($$("#summaryBody thead th")[1].textContent, "Nov");
  assert.ok(sumRow("Subscriptions").children[1].textContent, "November spending shows under 2027");
  assert.ok(sumRow("Subscriptions").dataset.key === "subscriptions", "rows are keyed (keeps your place across Actual/Predict)");
  button("#sumMode", "Predict").click();
  assert.deepEqual($$("#summaryBody thead th").slice(2, 5).map((th) => th.textContent), ["Nov", "Dec", "Jan"]);
  assert.match($("#summaryBody").textContent, /Predicted amounts for 2027 \(Nov 2026 – Oct 2027\)/);
  button("#sumMode", "Actual").click();

  // clicking a cell / the year filters Transactions by the financial year
  sumRow("Subscriptions").querySelector("td.label a").click();
  await settle();
  assert.equal($("#filterDate").value, "fy:2027");
  assert.match($("#filterDate").selectedOptions[0].textContent, /All of 2027 \(Nov 2026 – Oct 2027\)/);
  assert.ok($$("tr.tx").length >= 1);
  button("#filterCategory", "All but Archive").click();
  $("#filterDate").value = ""; fire($("#filterDate"), "change");

  // Settings: start in January = calendar years; predictions keep their calendar months
  const before = structuredClone(outboxNow().budget?.doc);
  await go("#settings");
  assert.equal($("#sFyStart").value, "11");
  assert.match($("#yearPanel").textContent, /This year is \d{4}: Nov \d{4} – Oct \d{4}/);
  $("#sFyStart").value = "1"; fire($("#sFyStart"), "change");
  await settle();
  const cal = outboxNow().budget.doc;
  assert.equal(cal.fyStart, 1);
  assert.equal(cal.years["2026"].travel.months[10], 40000, "Nov 2026's prediction is now in calendar 2026, still November");
  assert.equal(cal.years["2027"].travel.months[0], 10000);
  await go("#summary");
  $("#sumYear").value = "2026"; fire($("#sumYear"), "change");
  assert.equal($("#sumRange").textContent, "", "calendar years need no range");
  assert.equal($$("#summaryBody thead th")[1].textContent, "Nov");
  await go("#settings");
  $("#sFyStart").value = "11"; fire($("#sFyStart"), "change");
  await settle();
  if (before) assert.deepEqual(outboxNow().budget.doc, { ...before, fyStart: 11 }, "round trip");

  // group colors: picked in Edit categories, shown on the Summary
  await go("#summary");
  $("#editCategories").click();
  const firstGroup = $("#summaryBody .cat-group");
  const gname = firstGroup.querySelector(".cat-group-name").value;
  const color = firstGroup.querySelector("input.group-color");
  color.value = "#cc3300"; fire(color, "input");
  assert.equal(firstGroup.querySelector("button[title='No color']").hidden, false);
  button("#summaryBody", "Save categories").click();
  const gRow = sumRow(gname);
  assert.match(gRow.style.background, /rgb\(245, 214, 204\)/, "group row tinted (20% of the color)");
  assert.match(gRow.querySelector("td.label").style.boxShadow, /204, 51, 0|#cc3300/i);
  await settle();
  assert.equal(outboxNow().categories.doc.groups.find((g) => g.name === gname).color, "#cc3300");
});

test("Settings → Export all data: a zip of every data-repo file + browser state, saved first, no secrets", async () => {
  const { inflateRawSync } = await import("node:zlib");
  const unzip = (buf) => { // reads the central directory
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const end = buf.length - 22;
    assert.equal(dv.getUint32(end, true), 0x06054b50);
    const out = new Map();
    let p = dv.getUint32(end + 16, true);
    for (let i = 0; i < dv.getUint16(end + 10, true); i++) {
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      const lo = dv.getUint32(p + 42, true);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const body = buf.subarray(start, start + size);
      out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(body) : body));
      p += 46 + nameLen;
    }
    return out;
  };
  localStorage.setItem("fd:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("fd:settings")), anthropicKey: "sk-ant-secret" }));
  assert.ok(pending() > 0, "the previous test left unsaved edits");
  let blob = null;
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return "blob:fake"; };
  window.HTMLAnchorElement.prototype.click = function () { this.dataset.clicked = this.getAttribute("download"); };
  try {
    await go("#settings");
    $("#exportBackup").click();
    await settle();
  } finally { URL.createObjectURL = realCreate; }
  assert.ok(blob, "a download was started");
  assert.match($("#backupPanel .status").textContent, /Downloaded finance-backup-\d{4}-\d{2}-\d{2}\.zip/);
  assert.equal(pending(), 0, "pending edits were saved before exporting");

  const zip = unzip(new Uint8Array(await blob.arrayBuffer()));
  const repoFiles = [...gh.files().keys()].sort();
  assert.deepEqual([...zip.keys()].filter((n) => n.startsWith("data/")).map((n) => n.slice(5)).sort(), repoFiles, "every data-repo file");
  for (const f of repoFiles) assert.equal(zip.get(`data/${f}`), gh.files().get(f));
  assert.ok(repoFiles.some((f) => f.startsWith("transactions/")));
  for (const n of ["README.md", "backup.json", "browser/settings.json", "browser/ai-runs.json", "browser/unsaved-edits.json", "browser/ai-draft.json"]) assert.ok(zip.has(n), n);
  assert.ok(JSON.parse(zip.get("browser/ai-runs.json")).length > 0, "the AI log is included");
  assert.equal(JSON.parse(zip.get("backup.json")).repo, "me/finance-data");
  const all = [...zip.values()].join("\n");
  assert.doesNotMatch(all, /sk-ant-secret/, "no API key");
  assert.doesNotMatch(all, /"ghToken"|"anthropicKey"/, "no secret fields");
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

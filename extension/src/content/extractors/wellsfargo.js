// Wells Fargo extractor (connect.secure.wellsfargo.com account detail page).
// Built from page captures taken 2026-11-15 (checking + Active Cash Visa).
//
// Page facts:
// - Transactions are in <table data-testid="transaction-table">. Column meaning comes from
//   <th data-testid="transaction-heading-XXX">; th index == td index (both start with an expand column).
//     checking: DATE, DESCRIPTION, DEPOSITS_OR_CREDITS, WITHDRAWALS_OR_DEBITS  (unsigned; column gives sign)
//     card:     TRANSACTION_DATE, POSTING_DATE, DESCRIPTION, AMOUNT, RUNNING_BALANCE
//               charges are unsigned, credits/payments have a "+" span before the "$"
// - Checking pending rows sit in the same table after a "Pending Transactions" header row
//   (th.PendingTransactions__*), posted ones after th.PostedTransactions__*.
// - Card pending ("temporary authorizations") are a separate table inside #temporary-authorization.
// - Class names are CSS modules (Name__part___hash): match on the prefix, never the hash.
// - Pages show ~50 rows; [data-testid=pagination-next] pages through older ones.
(() => {
  const FD = globalThis.FD;
  const C = (prefix) => `[class*="${prefix}"]`;

  const SEL = {
    table: 'table[data-testid="transaction-table"], table[class*="TransactionsTable__transaction-list"]',
    heading: 'th[data-testid^="transaction-heading-"]',
    row: `tr${C("TransactionsRow__transaction-row")}`,
    description: C("TransactionItem__transactionDescription"),
    refSpan: ".OneLinkNoTx",
    pendingRegion: "#temporary-authorization",
    accountName: `h1${C("AccountDetailsHeader__title")}, h1#skipLinkTarget`,
    // checking: clickable [data-testid=account-number]; cards: span.AccountNumberList__masked-number-unclickable
    accountNumber: `[data-testid="account-number"], ${C("AccountNumberList__header-container")}`,
    balanceTile: '[data-testid="tile-body"]',
    balanceAmount: C("AccountDetailsTile__tile-amount"),
    balanceLabel: '[data-testid="balance-descriptor-container"]',
    nextPage: '[data-testid="pagination-next"]',
  };

  const text = (el) => (el ? FD.deepText(el) : "");

  /** Map heading key (DATE, AMOUNT, ...) -> column index. */
  function columnMap(table) {
    const ths = Array.from(table.querySelectorAll("thead tr:first-child > th, thead tr:first-child > td"));
    const map = {};
    ths.forEach((th, i) => {
      const id = th.getAttribute("data-testid") || "";
      if (id.startsWith("transaction-heading-")) map[id.slice("transaction-heading-".length)] = i;
    });
    return map;
  }

  function parseDescription(cell) {
    const main = cell.querySelector(SEL.description);
    const refs = Array.from(cell.querySelectorAll(SEL.refSpan)).map(text).filter(Boolean);
    let bankRef = null, cardLast4 = null;
    for (const r of refs) {
      const m4 = r.match(/^#\.\.\.(\d{4})$/);
      if (m4) cardLast4 = m4[1];
      else if (/^#[A-Z0-9]{8,}$/i.test(r)) bankRef = r.slice(1);
    }
    return { description: main ? text(main) : text(cell), bankRef, cardLast4 };
  }

  /** Card amount cell: "+ $ 3,681.84" = credit (positive); "$ 29.78" = charge (negative). */
  function cardAmount(cell) {
    const raw = text(cell);
    const isCredit = /^\s*\+/.test(raw);
    const cents = FD.parseAmountCents(raw.replace(/^\s*\+/, ""));
    if (cents === null) return null;
    return isCredit ? Math.abs(cents) : -Math.abs(cents);
  }

  function extractTable(table, warnings) {
    const cols = columnMap(table);
    const isCard = cols.AMOUNT !== undefined;
    const isChecking = cols.DEPOSITS_OR_CREDITS !== undefined || cols.WITHDRAWALS_OR_DEBITS !== undefined;
    if (!isCard && !isChecking) return { kind: null, txns: [] };
    const inPendingRegion = !!table.closest(SEL.pendingRegion);
    const dateCol = cols.TRANSACTION_DATE ?? cols.DATE;
    const postCol = cols.POSTING_DATE ?? cols.DATE;

    let section = inPendingRegion ? "pending" : "posted";
    const txns = [];
    for (const tr of table.querySelectorAll("tbody > tr")) {
      if (!tr.matches(SEL.row)) {
        // section header rows: <th class="PendingTransactions__..."> / <th class="PostedTransactions__...">
        const th = tr.querySelector("th");
        if (th && !inPendingRegion) {
          const cls = th.className || "";
          const t = text(th);
          if (/PendingTransactions__/.test(cls) || /^pending/i.test(t)) section = "pending";
          else if (/PostedTransactions__/.test(cls) || /^posted/i.test(t)) section = "posted";
        }
        continue;
      }
      const cells = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
      const date = FD.parseDate(text(cells[dateCol]));
      if (!date) { warnings.add("Skipped a row with no readable date."); continue; }
      const postedDate = postCol !== undefined && postCol !== dateCol ? FD.parseDate(text(cells[postCol])) : null;
      const { description, bankRef } = parseDescription(cells[cols.DESCRIPTION] || tr);

      let amountCents = null;
      if (isCard) amountCents = cardAmount(cells[cols.AMOUNT]);
      else {
        const dep = cols.DEPOSITS_OR_CREDITS !== undefined ? FD.parseAmountCents(text(cells[cols.DEPOSITS_OR_CREDITS])) : null;
        const wd = cols.WITHDRAWALS_OR_DEBITS !== undefined ? FD.parseAmountCents(text(cells[cols.WITHDRAWALS_OR_DEBITS])) : null;
        if (dep && wd) warnings.add("A row had both a deposit and a withdrawal; used the withdrawal.");
        amountCents = wd ? -Math.abs(wd) : dep ? Math.abs(dep) : null;
      }
      if (amountCents === null) { warnings.add(`Skipped a row with no readable amount (${date} ${description.slice(0, 30)}).`); continue; }

      txns.push({
        date,
        postedDate,
        description,
        merchantGuess: cleanDescription(description),
        amountCents,
        status: section,
        bankRef,
        signSource: isCard ? "wf-card-plus-marker" : "wf-checking-column",
        rawText: cells.map(text).filter(Boolean).join(" | "),
      });
    }
    return { kind: isCard ? "credit_card" : "checking", txns };
  }

  /** Strip WF boilerplate so the categorizer sees the merchant. Raw description is kept too. */
  function cleanDescription(desc) {
    return desc
      .replace(/\b(PURCHASE|RECURRING PAYMENT) (AUTHORIZED|INTL) ON \d{1,2}\/\d{1,2}\b/i, "")
      .replace(/\b[SP]\d{12,}\b/g, "")
      .replace(/\bCARD \d{4}\b/i, "")
      .replace(/\b\d{3}-\d{3}-\d{4}\b/g, "") // phone numbers in card descriptors
      .replace(/\s+/g, " ")
      .trim();
  }

  function accountInfo(kind) {
    const name = text(document.querySelector(SEL.accountName)).replace(/\s*®\s*/g, " ").replace(/\s+/g, " ").trim();
    const last4 = FD.findLast4(text(document.querySelector(SEL.accountNumber))) || FD.findLast4(name);
    let type = kind;
    if (/savings/i.test(name)) type = "savings";
    else if (/card|visa|mastercard/i.test(name)) type = "credit_card";
    else if (!type && /checking/i.test(name)) type = "checking";
    return { name, last4, type };
  }

  function balance(type) {
    const tile = document.querySelector(SEL.balanceTile);
    if (!tile) return { balanceCents: null, balanceLabel: null };
    const cents = FD.parseAmountCents(text(tile.querySelector(SEL.balanceAmount)));
    const label = text(tile.querySelector(SEL.balanceLabel)).replace(/\s*-\s*Opens a dialog/i, "").trim() || null;
    if (cents === null) return { balanceCents: null, balanceLabel: label };
    // card "Outstanding balance" is money owed -> negative for net worth
    return { balanceCents: type === "credit_card" ? -Math.abs(cents) : cents, balanceLabel: label };
  }

  function extractWellsFargo() {
    const warnings = new Set();
    const tables = FD.allElements(document).filter((el) => el.matches && el.matches(SEL.table));
    let kind = null;
    const transactions = [];
    for (const t of tables) {
      const r = extractTable(t, warnings);
      if (r.kind) kind = kind || r.kind;
      transactions.push(...r.txns);
    }
    if (!tables.length) return null;

    const account = accountInfo(kind);
    const next = document.querySelector(SEL.nextPage);
    return {
      hasMorePages: !!next && next.getAttribute("aria-disabled") === "false",
      method: "wellsfargo-table",
      transactions,
      account,
      ...balance(account.type),
      warnings: [...warnings],
    };
  }

  FD.registerExtractor({
    id: "wellsfargo",
    institution: "wellsfargo",
    priority: 10,
    matches: (loc) => /(^|\.)wellsfargo\.com$/i.test(loc.hostname),
    extract: () => {
      const r = extractWellsFargo();
      if (r && r.transactions.length) return r;
      // layout changed or not on an account-detail page: fall back to heuristics
      const g = FD.genericExtract();
      return {
        ...g,
        account: r ? r.account : { name: document.title, last4: null, type: null },
        warnings: ["Wells Fargo layout not recognized; used generic heuristics. Capture this page so the extractor can be updated.", ...g.warnings],
      };
    },
  });
})();

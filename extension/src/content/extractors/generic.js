// Generic heuristic extractor: works on most "list of transactions" pages.
// Institution-specific extractors call FD.genericExtract() as a fallback.
(() => {
  const FD = globalThis.FD;

  const COL_PATTERNS = {
    date: /^(trans(action)?\.?\s*)?date|^posted|^post date/i,
    description: /desc|merchant|payee|details|transaction$/i,
    amount: /^amount$|^amount\b/i,
    debit: /withdraw|debit|charges?|payments? out/i,
    credit: /deposit|credit|payments? in/i,
    balance: /balance/i,
  };

  function classifyHeaders(headers) {
    const idx = {};
    headers.forEach((h, i) => {
      for (const [key, re] of Object.entries(COL_PATTERNS)) {
        if (idx[key] === undefined && re.test(h)) { idx[key] = i; break; }
      }
    });
    return idx;
  }

  function cellsOf(row) {
    let cells = Array.from(row.querySelectorAll(":scope > td, :scope > th, :scope > [role=cell], :scope > [role=gridcell], :scope > [role=rowheader]"));
    return cells;
  }

  /** Structured path: real <table> or ARIA grid with recognizable headers. */
  function fromTables(root) {
    const tables = FD.allElements(root).filter((el) => el.tagName === "TABLE" || /^(grid|table|treegrid)$/.test(el.getAttribute("role") || ""));
    let best = null;
    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll("th, [role=columnheader]"));
      const headers = headerCells.map((h) => FD.deepText(h));
      const idx = classifyHeaders(headers);
      if (idx.date === undefined || (idx.amount === undefined && idx.debit === undefined && idx.credit === undefined)) continue;

      const rows = Array.from(table.querySelectorAll("tr, [role=row]"));
      const txns = [];
      for (const row of rows) {
        const cells = cellsOf(row).map((c) => FD.deepText(c));
        if (cells.length < 2 || cells.length < headers.length - 2) continue;
        const date = FD.parseDate(cells[idx.date]);
        if (!date) continue;
        let amountCents = null, signSource = "ambiguous";
        if (idx.debit !== undefined || idx.credit !== undefined) {
          const d = idx.debit !== undefined ? FD.parseAmountCents(cells[idx.debit]) : null;
          const c = idx.credit !== undefined ? FD.parseAmountCents(cells[idx.credit]) : null;
          if (d) { amountCents = -Math.abs(d); signSource = "column"; }
          else if (c) { amountCents = Math.abs(c); signSource = "column"; }
        }
        if (amountCents === null && idx.amount !== undefined) {
          const raw = cells[idx.amount];
          amountCents = FD.parseAmountCents(raw);
          if (/[-−(]/.test(raw)) signSource = "explicit";
        }
        if (amountCents === null) continue;
        const description = idx.description !== undefined
          ? cells[idx.description]
          : cells.filter((_, i) => ![idx.date, idx.amount, idx.debit, idx.credit, idx.balance].includes(i)).join(" ");
        const rowText = cells.join(" | ");
        txns.push({
          date, description: description.trim(), amountCents, signSource,
          status: /pending/i.test(rowText) || FD.inPendingSection(row) ? "pending" : "posted",
          rawText: rowText,
        });
      }
      if (!best || txns.length > best.length) best = txns;
    }
    return best || [];
  }

  /** Unstructured path: smallest elements whose text has both a date and a money amount, grouped by shape. */
  function fromTextRows(root) {
    const els = FD.allElements(root);
    const textCache = new Map();
    const text = (el) => {
      if (!textCache.has(el)) textCache.set(el, FD.deepText(el));
      return textCache.get(el);
    };
    const MONEY_TEST = /\$\s?\d|\d\.\d{2}\b/;
    const candidates = els.filter((el) => {
      if (/^(SCRIPT|STYLE|HTML|BODY|HEAD|svg)$/i.test(el.tagName)) return false;
      const t = text(el);
      return t.length > 0 && t.length < 400 && FD.DATE_RE.test(t) && MONEY_TEST.test(t);
    });
    const set = new Set(candidates);
    // keep only "minimal" candidates (no candidate descendant)
    const minimal = candidates.filter((el) => {
      for (const other of set) if (other !== el && el.contains(other)) return false;
      return true;
    });
    // group by structural signature, pick the biggest group
    const sig = (el) => `${el.tagName}.${Array.from(el.classList).filter((c) => !/\d{3,}/.test(c)).sort().join(".")}|${el.getAttribute("role") || ""}`;
    const groups = new Map();
    for (const el of minimal) {
      const k = sig(el);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(el);
    }
    let rows = [];
    for (const g of groups.values()) if (g.length > rows.length) rows = g;

    const warnings = [];
    const txns = [];
    for (const row of rows) {
      const t = text(row);
      const dm = t.match(FD.DATE_RE);
      const date = dm && FD.parseDate(dm[0]);
      if (!date) continue;
      const afterDate = t.replace(dm[0], " ");
      const amounts = (afterDate.match(FD.MONEY_RE) || []).map((s) => ({ s, c: FD.parseAmountCents(s) })).filter((a) => a.c !== null);
      if (!amounts.length) continue;
      if (amounts.length > 1 && !warnings.length) warnings.push("Some rows contain multiple amounts; using the first (later ones assumed to be running balance).");
      const amt = amounts[0];
      let description = afterDate;
      for (const a of amounts) description = description.replace(a.s, " ");
      description = description.replace(/\bpending\b/i, " ").replace(/\s+/g, " ").trim();
      txns.push({
        date, description, amountCents: amt.c,
        signSource: /[-−(]/.test(amt.s) ? "explicit" : "ambiguous",
        status: /\bpending\b/i.test(t) || FD.inPendingSection(row) ? "pending" : "posted",
        rawText: t,
      });
    }
    return { txns, warnings };
  }

  FD.genericExtract = (root = document) => {
    const tableTxns = fromTables(root);
    const textResult = fromTextRows(root);
    const useTable = tableTxns.length >= textResult.txns.length && tableTxns.length > 0;
    const transactions = useTable ? tableTxns : textResult.txns;
    const warnings = useTable ? [] : textResult.warnings;
    if (!transactions.length) warnings.push("No transaction rows found. Capture the page for analysis so a site-specific extractor can be written.");
    if (transactions.some((t) => t.signSource === "ambiguous")) warnings.push("Some amounts have no explicit sign. Check the sign toggle before saving.");
    return { method: useTable ? "table" : "text-rows", transactions, warnings };
  };

  FD.registerExtractor({
    id: "generic",
    institution: null,
    priority: 0,
    matches: () => true,
    extract: () => {
      const r = FD.genericExtract();
      const header = FD.deepText(document.querySelector("h1, [role=heading]") || document.body).slice(0, 200);
      return {
        ...r,
        account: { name: document.title, last4: FD.findLast4(header) },
      };
    },
  });
})();

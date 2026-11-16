// Shared helpers injected into bank pages (classic script, no modules).
// Everything hangs off globalThis.FD so repeated injections are harmless.
// READ-ONLY: nothing in the content scripts may click, type, or submit.
(() => {
  const FD = (globalThis.FD = globalThis.FD || {});
  FD.extractors = FD.extractors || [];

  FD.registerExtractor = (ex) => {
    FD.extractors = FD.extractors.filter((e) => e.id !== ex.id);
    FD.extractors.push(ex);
  };

  // ---------- parsing ----------
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // Matches $1,234.56  -$5.00  ($5.00)  −$5.00  $5.00-  1,234.56 (when $ present somewhere)
  FD.MONEY_RE = /[-−–(]?\s?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\)?(?:\s?-)?|[-−–(]?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?/g;
  FD.DATE_RE = /\b(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)\b/i;

  const pad = (n) => String(n).padStart(2, "0");

  /** "$1,234.56" -> 123456, "($5.00)" -> -500, "-$5" -> -500. Returns null if not money. */
  FD.parseAmountCents = (str) => {
    if (str == null) return null;
    let s = String(str).trim().replace(/[−–]/g, "-");
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ""); }
    if (/\bCR\b/i.test(s)) { s = s.replace(/\bCR\b/i, ""); } // credit marker: caller decides sign
    if (s.includes("-")) { neg = true; s = s.replace(/-/g, ""); }
    s = s.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [whole, frac = ""] = s.split(".");
    const cents = parseInt(whole, 10) * 100 + parseInt((frac + "00").slice(0, 2), 10);
    return neg ? -cents : cents;
  };

  /** Parses US-style dates to YYYY-MM-DD. refDate is used to infer a missing year. */
  FD.parseDate = (str, refDate = new Date()) => {
    if (!str) return null;
    const s = String(str).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      return valid(y, +m[1], +m[2]);
    }
    if ((m = s.match(/(\d{1,2})\/(\d{1,2})(?!\/)/))) return withInferredYear(+m[1], +m[2], refDate);
    if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/))) {
      const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3)];
      if (!mon) return null;
      if (m[3]) return valid(+m[3], mon, +m[2]);
      return withInferredYear(mon, +m[2], refDate);
    }
    return null;
  };

  function valid(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  // A month later than "now" with no year means last year (e.g. "Dec 28" seen in January).
  function withInferredYear(mo, d, ref) {
    let y = ref.getFullYear();
    if (mo > ref.getMonth() + 1) y -= 1;
    return valid(y, mo, d);
  }

  // ---------- DOM helpers (shadow-DOM aware) ----------
  /** All elements under root, descending into open shadow roots and same-origin iframes. */
  FD.allElements = (root = document) => {
    const out = [];
    const walk = (node) => {
      const kids = node.children || [];
      for (const el of kids) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === "IFRAME") {
          try { if (el.contentDocument) walk(el.contentDocument); } catch (_) { /* cross-origin */ }
        }
        walk(el);
      }
    };
    walk(root);
    return out;
  };

  /** Visible-ish text including shadow DOM content, whitespace collapsed. */
  FD.deepText = (el) => {
    let parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const c of node.childNodes) walk(c);
      if (node.nodeType === 1 && /^(DIV|P|TD|TH|LI|TR|SPAN|BR)$/.test(node.tagName)) parts.push(" ");
    };
    walk(el);
    return parts.join("").replace(/\s+/g, " ").trim();
  };

  FD.isVisible = (el) => {
    if (typeof el.checkVisibility === "function") return el.checkVisibility();
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };

  /** Walks up from el looking for a section heading that mentions "pending". */
  FD.inPendingSection = (el) => {
    let cur = el;
    for (let i = 0; i < 10 && cur; i++) {
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
      if (!cur) break;
      const heading = cur.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role=heading], :scope > caption, :scope > header");
      if (heading) {
        const t = FD.deepText(heading);
        if (/pending/i.test(t)) return true;
        if (/posted|completed|cleared/i.test(t)) return false;
      }
    }
    return false;
  };

  /** Finds "...1234" / "x1234" / "ending in 1234" account suffixes in text. */
  FD.findLast4 = (text) => {
    const m = String(text).match(/(?:\.{3}|…|x|\*{2,}|ending in\s*)(\d{4})\b/i);
    return m ? m[1] : null;
  };
})();

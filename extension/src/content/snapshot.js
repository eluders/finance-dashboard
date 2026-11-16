// Serializes the current page's DOM structure for offline analysis (writing extractors).
// Strips scripts/styles/images, keeps tags + useful attributes + text, flattens open shadow
// roots and same-origin iframes. Optional redaction scrambles amounts and masks long digit runs.
// Expects globalThis.FD_SNAPSHOT_OPTS = { redact: boolean } to be set before injection.
(() => {
  const opts = globalThis.FD_SNAPSHOT_OPTS || { redact: true };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO", "SOURCE", "PICTURE"]);
  const KEEP_ATTR = /^(id|class|role|name|type|title|alt|for|colspan|rowspan|headers|scope|href|tabindex|aria-.*|data-.*)$/i;
  const MAX_BYTES = 8 * 1024 * 1024;
  let bytes = 0, truncated = false, elementCount = 0;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
  const rand = () => String(Math.floor(Math.random() * 10));

  function redact(text) {
    if (!opts.redact) return text;
    // scramble money digits but keep format ($1,234.56 -> $7,019.38)
    text = text.replace(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, (m) => m.replace(/\d/g, rand));
    // mask 5+ digit runs (full account/card/reference numbers); 4-digit "...1234" suffixes and years survive
    text = text.replace(/\b\d{5,}\b/g, (m) => "0".repeat(m.length));
    return text;
  }

  function attrs(el) {
    let out = "";
    for (const a of el.attributes) {
      if (!KEEP_ATTR.test(a.name)) continue;
      let v = a.value;
      if (a.name === "href") v = v.split("?")[0].split("#")[0];
      if (/^data-/i.test(a.name) || /^aria-/i.test(a.name) || a.name === "title") v = redact(v);
      if (v.length > 300) v = v.slice(0, 300) + "…";
      out += ` ${a.name}="${escAttr(v)}"`;
    }
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) out += ' data-fd-hidden="1"';
    return out;
  }

  function ser(node, depth) {
    if (bytes > MAX_BYTES) { truncated = true; return ""; }
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, " ");
      if (!t.trim()) return "";
      const s = esc(redact(t));
      bytes += s.length;
      return s;
    }
    if (node.nodeType === 11) return Array.from(node.childNodes).map((c) => ser(c, depth)).join("");
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    if (SKIP.has(tag)) return "";
    elementCount++;
    const name = tag.toLowerCase();
    if (name === "svg") return `<svg${node.getAttribute("aria-label") ? ` aria-label="${escAttr(node.getAttribute("aria-label"))}"` : ""}/>`;
    if (name === "img") return `<img${attrs(node)}/>`;
    if (name === "input" || name === "select" || name === "textarea") {
      // never serialize field values
      return `<${name}${attrs(node)}/>`;
    }
    let inner = "";
    if (node.shadowRoot) inner += `<fd-shadow-root>${ser(node.shadowRoot, depth + 1)}</fd-shadow-root>`;
    if (tag === "IFRAME") {
      let doc = null;
      try { doc = node.contentDocument; } catch (_) {}
      inner += doc && doc.body ? `<fd-iframe-doc>${ser(doc.body, depth + 1)}</fd-iframe-doc>` : `<!-- cross-origin iframe: ${esc((node.src || "").split("?")[0])} -->`;
    }
    for (const c of node.childNodes) inner += ser(c, depth + 1);
    const open = `<${name}${attrs(node)}>`;
    bytes += open.length + name.length + 3;
    return `${open}${inner}</${name}>`;
  }

  const body = ser(document.body, 0);
  const loc = window.location;
  const header = `<!-- Finance Dashboard page capture
url: ${loc.origin}${loc.pathname}
title: ${esc(document.title)}
captured: ${new Date().toISOString()}
redacted: ${opts.redact}
elements: ${elementCount}${truncated ? "\nTRUNCATED at 8MB" : ""}
Notes: <fd-shadow-root> = open shadow root contents; <fd-iframe-doc> = same-origin iframe; data-fd-hidden="1" = not visible.
-->\n`;
  return {
    ok: true,
    host: loc.hostname,
    html: `<!DOCTYPE html>\n${header}<html><head><title>${esc(document.title)}</title></head>${body}</html>`,
    elementCount,
    truncated,
  };
})();

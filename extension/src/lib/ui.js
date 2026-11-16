// Small helpers shared by the extension popup/options and the web dashboard.

/** Extension pages only: runs an operation in the background worker. */
export async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error("No response from background worker");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export const fmtMoney = (cents) =>
  (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : String(c));
  return e;
};

/** "2026-11-14" -> "11-14-2026" */
export const fmtDate = (iso) => (iso ? `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}` : "");

const PALETTE = ["#3b6fd8", "#e07b39", "#2a9d6f", "#b04fc4", "#d6455a", "#2f9fb3", "#a8902c", "#6d5bd0", "#5a8f3c", "#c4577f"];

/** Account's chosen color, or a stable default derived from its id. */
export function accountColor(a) {
  if (a?.color) return a.color;
  let h = 0;
  for (const ch of a?.id || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Black or white text, whichever reads better on the background. */
export function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#111" : "#fff";
}

/** Colored "…1234" pill for an account. */
export function accountBadge(a) {
  const bg = accountColor(a);
  const b = document.createElement("span");
  b.className = "acct";
  b.style.background = bg;
  b.style.color = textOn(bg);
  b.textContent = a?.last4 ? `…${a.last4}` : (a?.name || "?").slice(0, 6);
  b.title = a ? `${a.name} (${a.institution})` : "";
  return b;
}

export const slug =(s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

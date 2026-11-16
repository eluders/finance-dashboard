// Storage for code shared by the extension and the web dashboard (web/):
// chrome.storage.local inside the extension, localStorage (keys prefixed "fd:") on a web page.

const PREFIX = "fd:"; // localStorage key prefix

/** chrome.storage.local-compatible facade over localStorage (get/set of JSON values). */
function localStorageArea() {
  const listeners = new Set();
  const getOne = (k) => { const v = localStorage.getItem(PREFIX + k); return v == null ? undefined : JSON.parse(v); };
  const area = {
    async get(keys) {
      const list = keys == null ? Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
        : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.map((k) => [k, getOne(k)]).filter(([, v]) => v !== undefined));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: getOne(k), newValue: v };
        localStorage.setItem(PREFIX + k, JSON.stringify(v));
      }
      for (const l of listeners) l(changes, "local");
    },
    async remove(keys) {
      for (const k of [].concat(keys)) localStorage.removeItem(PREFIX + k);
    },
    onChanged: { addListener: (fn) => listeners.add(fn) },
  };
  // other tabs of the same site
  globalThis.addEventListener?.("storage", (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    const changes = { [e.key.slice(PREFIX.length)]: { oldValue: e.oldValue && JSON.parse(e.oldValue), newValue: e.newValue && JSON.parse(e.newValue) } };
    for (const l of listeners) l(changes, "local");
  });
  return area;
}

let _storage;
/** The persistent key/value store for settings, the edit outbox, etc. */
export function storage() {
  return (_storage ||= globalThis.chrome?.storage?.local || localStorageArea());
}

/** Subscribe to storage changes in this store (same tab and other tabs). */
export function onStorageChanged(fn) {
  const s = storage();
  if (s.onChanged) s.onChanged.addListener(fn);
  else globalThis.chrome.storage.onChanged.addListener(fn);
}

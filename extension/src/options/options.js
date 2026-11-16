import { call } from "../lib/ui.js";

const FIELDS = ["ghOwner", "ghRepo", "ghBranch", "ghToken"];
const $ = (id) => document.getElementById(id);
const status = (msg, cls = "") => { $("status").className = `status ${cls}`; $("status").textContent = msg; };

(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  for (const f of FIELDS) $(f).value = settings[f] || "";
})();

async function save() {
  const settings = {};
  for (const f of FIELDS) settings[f] = $(f).value.trim();
  settings.ghBranch ||= "main";
  await chrome.storage.local.set({ settings });
}

$("save").onclick = async () => { await save(); status("Saved.", "good"); };

$("test").onclick = async () => {
  await save();
  status("Testing…");
  try {
    const r = await call("testConnection");
    const problems = [!r.private && "REPO IS PUBLIC — make it private", !r.canPush && "token cannot push"].filter(Boolean);
    status(`Connected to ${r.fullName}${r.empty ? " (empty — click Initialize)" : ""}.${problems.length ? "\n⚠ " + problems.join("; ") : ""}`, problems.length ? "bad" : "good");
  } catch (e) { status(e.message, "bad"); }
};

$("init").onclick = async () => {
  await save();
  status("Initializing…");
  try {
    const r = await call("initDataRepo");
    status(r.created.length ? `Created: ${r.created.join(", ")}` : "Already initialized.", "good");
  } catch (e) { status(e.message, "bad"); }
};

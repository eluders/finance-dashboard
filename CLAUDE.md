# Finance Dashboard — notes for Claude

Personal finance tracker. Two parts, no backend, no build step:
- **Chrome MV3 extension** (`extension/`): extraction only. Popup: Extract → Compare → Save, plus Capture.
- **Web dashboard** (`web/`): a static page on GitHub Pages that reads and writes the private data repo straight from the browser.

Storage for both is a private GitHub data repo. Don't put dashboard features in the extension; the user wants it kept lean.

## Hard rules
- **Extraction is read-only.** Content scripts must never click, type, submit, or navigate on bank sites. If a page needs "load more", tell the user to click it.
- **Never commit financial data to this code repo.** Captures go in `samples/` (gitignored). Don't paste real amounts/account numbers into tests: synthesize fixtures.
- Secrets live only in browser storage, never in a repo. The extension uses `chrome.storage.local`. The web dashboard uses `localStorage` key `fd:settings`, and its Settings panel never echoes a saved token back into the page.
- The web page's CSP (`web/index.html`) allows connections only to api.github.com. Add api.anthropic.com there when the categorizer lands, since the categorizer belongs in the web app.
- Money is integer cents (`amountCents`), negative = out of the account. Dates are `YYYY-MM-DD`.

## Layout
- `extension/manifest.json`: permissions: `activeTab`, `scripting`, `storage`; hosts: api.github.com.
- `extension/src/content/`: **classic scripts** (not modules) injected on click via `chrome.scripting.executeScript({files})`. They share `globalThis.FD`.
  - `common.js`: parsing (amount/date), shadow-DOM-aware DOM helpers, extractor registry.
  - `extractors/generic.js`: heuristic table / text-row extractor, used as the fallback.
  - `extractors/<institution>.js`: site-specific; `registerExtractor({id, institution, priority, matches(location), extract()})`.
  - `run-extract.js`: must be injected last; returns the result object to the popup.
  - `snapshot.js`: sanitized DOM capture for writing extractors.
- `extension/src/lib/`: ES modules **shared by the extension and `web/`**. The web page imports them as `../extension/src/lib/*.js`. Keep them free of extension-only APIs, and use `platform.js` `storage()`, which is chrome.storage.local in the extension and localStorage on the web.
  - `github.js`: `GitHubRepo` with SHA-pinned reads and `transact()`, an atomic multi-file commit with retry.
  - `store.js`: data-repo operations (accounts, transactions by account/year, imports log, balances).
  - `reconcile.js`: dedupe by (date, amount) multiset plus pending→posted linking.
- `extension/src/background.js`: message router for the popup. Import saves go through it so they survive the popup closing.
- `extension/src/popup/`: Extract (which compares with saved data right away) → Save; Capture. There's no dashboard link: the user wants the extension to be extraction only.
- `web/`: the dashboard.
  - Files:
    - `index.html`
    - `dashboard.js`: hash-routed tabs. `#summary`: net outflow per category per month (split parts count separately, sections at `sectionBreak` groups, cells link to filtered transactions), plus "Edit categories" mode with the drag-to-reorder editor. `#transactions`: filters by account, category or group, and month, with inline note, category and split edits. `#settings`: connection and account colors.
    - `lib/backend.js`: in-page operations and the auto-save timer.
    - `lib/outbox.js`.
  - Edits (note, category, splits, categories doc) never call GitHub directly. `edits.js` applies them in memory, and `outbox.js` buffers them in localStorage. They're flushed as one commit through `store.applyEdits` about 60s after the first unsaved edit, or on "Save now" or tab close.
  - The timer only runs while a tab is open. On load, unflushed edits are overlaid on the GitHub data and then saved.
  - To run it locally, start a static server at the repo root (e.g. `npx serve .`) and open `/web/`.
  - Deploy: `.github/workflows/pages.yml` publishes only `web/` and `extension/src/lib/` on push to main.
- `tests/`: `npm test`. `tests/helpers/run-extractor.mjs` runs the content scripts in jsdom, the same way the popup injects them. `tests/fixtures/` holds **synthetic** HTML that copies real page structure.
- `tools/apply-csv-labels.mjs`: `node tools/apply-csv-labels.mjs transactions.csv --repo owner/data-repo [--write]`. It copies labels from the user's spreadsheet (note, category, splits, overrides) onto saved transactions, matching on account last 4 + amount + date (±4 days). It only applies unambiguous matches, never overwrites dashboard edits, and writes a `*-unmatched.csv` with a reason per row. Re-run it after importing more history.
- `tools/try-samples.mjs`: `node tools/try-samples.mjs samples/wellsfargo --rows` runs the extractors against real local captures. Use it after any extractor change.

## Wells Fargo notes (from captures, 2026-11-15)
- Every account uses the same SPA URL (`/accounts/inquiry/summary/home/default`). Identify the account by the header's last4, never by the URL.
- CSS-module class names (`Name__part___hash`): match on the `Name__part` prefix plus `data-testid`. Never use the hash.
- Checking: separate Deposits/Withdrawals columns; pending and posted sections in one table. Cards: one Amount column, credits marked with a `+` span; pending items in a separate table in `#temporary-authorization`; posted rows have a unique ref (`.OneLinkNoTx`), stored as `bankRef`.
- About 50 rows per page. The user pages with Next and extracts again; dedupe skips the overlap.

## Adding an extractor
1. The user captures the page (popup → Capture). The file lands in `samples/<institution>/`.
2. Read the capture and identify the row selector, fields, sign convention, and pending section.
3. Write `extractors/<institution>.js`, add it to `EXTRACT_FILES` in `popup.js` (before `run-extract.js`), and fall back to `FD.genericExtract()` if the selectors find nothing.
4. Return `{ method, transactions: [{date, description, amountCents, status, signSource, rawText, merchantGuess?}], account: {name, last4, type}, balanceCents?, warnings }`.
5. Add a synthetic fixture test where practical.

## Claude API (categorizer, upcoming)
Called directly from the extension with `fetch` to `https://api.anthropic.com/v1/messages`. Browser calls need the header `anthropic-dangerous-direct-browser-access: true`. Default model: `claude-opus-5-5` unless the user picks another. Learning loop: user corrections → `corrections.json` → deterministic `rules.json` entries, plus periodic rewrites of `ai-notes.md`, which goes into the categorization prompt.

# Finance Dashboard — notes for Claude

Personal finance tracker. Two parts, no backend, no build step:
- **Chrome MV3 extension** (`extension/`): extraction only. Popup: Extract → Compare → Save, plus Capture.
- **Web dashboard** (`web/`): a static page on GitHub Pages that reads and writes the private data repo straight from the browser.

Storage for both is a private GitHub data repo. Don't put dashboard features in the extension; the user wants it kept lean.

## Hard rules
- **Extraction is read-only.** Content scripts must never click, type, submit, or navigate on bank sites. If a page needs "load more", tell the user to click it.
- **Never commit financial data to this code repo.** Captures go in `samples/` (gitignored). Don't paste real amounts/account numbers into tests: synthesize fixtures.
- Secrets live only in browser storage, never in a repo. The extension uses `chrome.storage.local`. The web dashboard uses `localStorage` key `fd:settings`, and its Settings panel never echoes a saved token back into the page.
- The web page's CSP (`web/index.html`) allows connections only to api.github.com and api.anthropic.com.
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
    - `dashboard.js`: hash-routed tabs. `#summary`: net outflow per category per month (split parts count separately, a bigger gap before `sectionBreak` groups, cells link to filtered transactions), plus "Edit categories" mode with the drag-to-reorder editor.
      - A standalone table per group (identical fixed `colgroup`, so columns line up) with a small gap between them, and ONE column header (`.sum-head`) pinned under the sticky top bar; the page itself scrolls (no inner scroll box). No Subtotal rows: the user wants the group's header row to be its subtotal, showing the actual sum and, with Predictions on, the predicted sum on a second line (`.agg-pred`) in each cell. No separate Predict view (the user asked for predictions side by side). Every month of the financial year is shown, even future ones; Avg / mo divides by the span of months that have data. Columns: 12 months | Total | Avg / mo | Predicted / mo | Monthly. With the "Predictions" toggle on (default; localStorage `fd:summaryView`), each category's actual row is followed by a prediction row: an entry box under each month, the predicted total under Total, and the Monthly box in the LAST column so the months don't shift. Backed by `budget.json` (`extension/src/lib/budget.js`). A Monthly amount fills and locks all 12 months; clearing it leaves the months filled and editable. Without Monthly, avg/mo = sum of entered months / 12. Predicted values are always dark orange (`--pred`). The user tried and removed a Minimize/Maximize split: don't bring it back.
      - Budget edits go through the outbox as a whole-doc `{type: "budget", doc}` op, like categories.
      - **Financial year**: `budget.fyStart` (default 11 = November; Settings → Financial year). A year is named by the year it ENDS in ("2027" = Nov 2026 – Oct 2027). The summary, the prediction rows (`months[0]` = first month of the financial year) and the transaction date filter (`fy:2027` options) all use it. Changing the start re-files predictions with `rebaseBudget` so single months keep their calendar month. Budgets without `fyStart` were calendar years and get migrated on read.
      - Showing/hiding predictions keeps the row at the top of the table in place (`tr[data-key]` anchor), not the raw scroll offset.
      - **Group colors**: optional `color` (`#rrggbb`) per group, picked in Edit categories. On the Summary the group row is tinted 20%, its categories 7%, with a stripe on the label.
      - **Archived categories**: optional `archivedFrom: "YYYY-MM"` per category (Edit categories → "Archive…" → month picker; "Unarchive"). Not the built-in Archive *category*. `archivedAt(c, date)` in `categories.js`. On the Summary a category is shown only in years it was still in use for some month, or that still have money in it. Archived months are grayed (`td.off`), money still in them is red (`td.stray`), prediction boxes there are disabled and those months' predictions don't count (they're kept, in case it's unarchived). Transaction dropdowns don't offer a category archived by the row's date, except the one it's already in, which shows red with "(archived)". The AI prompt marks them, and `evaluateRules` drops proposals into a category archived by the transaction's date.
    - `#transactions`: filters by account, category or group, and month, with inline note, category and split edits. `#settings`: connection and account colors.
    - `lib/backend.js`: in-page operations, the auto-save timer, the Claude request (the key stays in this module), and the AI run log (localStorage `fd:aiRuns`).
    - `lib/outbox.js`.
    - `lib/zip.js`: a dependency-free .zip writer (deflate-raw via `CompressionStream`, falling back to stored). Settings → "Export all data" (`exportBackup` in `backend.js`) saves pending edits first, then zips `data/<every repo file at one commit>` plus `browser/` (settings without secrets, AI runs, outbox, AI draft) and a restore README. Never put `ghToken` or `anthropicKey` in it.
    - `ai-panel.js` + `lib/ai.js`: the AI categorize panel on Transactions, and the `#logs` tab (see below).
    - `cat-picker.js`: checkbox category picker (group boxes, All/None/All but Archive, per-row "only"), used by the transaction filter and the AI panel. No "All <group>" pseudo-entries: the user wants the bold group rows themselves to be selectable.
    - `cell-select.js`: Excel-style multi-select on the Category column. **No toolbar and no prompts**: the user wants pasting to be instant and in place.
      - Each cell has a blank strip on its left (`cursor: cell`) for clicking and dragging.
      - A click on the dropdown opens it. Mousedown is held back so it can become a drag; the dropdown opens via `showPicker()` on release.
      - Drag, shift-click and ctrl-click select cells. Ctrl+C copies a category (the cell gets a dashed outline); Ctrl+V pastes it at once, and the changed cells flash.
      - Delete clears, Ctrl+Z undoes the last paste or delete, Esc clears.
      - Bulk changes go through `setTxCategories` → one `queueEdits` outbox write. AI Apply uses the same path.
    - The summary's column header is pinned: `.sum-head` is `position: sticky` at `--topbar-h` (set from the top bar's height). Showing/hiding predictions keeps the row just under it in place via `window.scrollBy`.
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

## AI categorize (panel on the Transactions tab; sessions logged on `#logs`)
- Scope = the rows the transaction table's filters show (`shownRows()`), optionally only uncategorized ones. There's no separate date or category scope in the tool, by the user's choice.
- While reviewing, the table shows only the affected rows, with an "After (AI)" checkbox column. Apply, Discard and Later sit at the top of the panel. Logs show each run's first 5 rows ("Show all N"), with the actions above them.
- Memory: there are no user-written notes, by the user's choice. The AI keeps `ai-notes.md` in the data repo, which is viewable and editable (collapsed) in the panel.
  - Each session has a free-text notes box. Unless "One-time only" is ticked, the model may end its reply with `NOTES:` plus the complete updated notes.
  - The panel shows the update as a +/− line diff, approved together with the category changes. It isn't saved if the notes changed since the run.
  - "Rebuild from my history" rewrites the notes from merchant history.
  - "Notes only" sessions send no transactions (`buildNotesUpdatePrompt`). The reply is the complete updated notes, reviewed as a diff in the panel; the table isn't put in review mode (`review()` returns null for runs with no proposals).
- Called from the page with `fetch` to `https://api.anthropic.com/v1/messages`. It streams, uses API version `2026-10-21`, and sends the header `anthropic-dangerous-direct-browser-access: true`. There's no SDK because the page has no build step.
- The default model is **`claude-haiku-5-5`**: the user asked for a cheap model. Sonnet and Opus can be picked in Settings. The form shows a token/cost estimate and warns above 100K prompt tokens, where Haiku's price is 5x.
- Safety model: the AI can only *propose category changes*.
  - It replies in a tiny rule language (`SET <category_id> WHERE <cond> AND ...`; see `web/lib/ai.js`).
  - The page evaluates the rules, and only against the transactions it sent. Split transactions are never sent.
  - Proposals are shown before → after and must be applied by the user.
  - Applying is category-only, through `commitEdit`, which keeps note, splits and override. It's skipped if the category changed since the run.
- The prompt is compact (`ref|date|amount|last4|description|note|category` lines), plus optional "merchant → category ×n" examples drawn from history.
- The built-in **Archive** category (`ARCHIVE_ID = "archive"`, in `categories.js`) isn't part of the user's groups. Archived transactions are excluded from the summary, and from the transaction list unless the user filters to Archive.
- Possible later: turn `corrections.json` into deterministic `rules.json` entries.

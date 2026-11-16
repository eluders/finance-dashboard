# Finance Dashboard

A personal finance tracker in two parts, with your data kept in a private GitHub repo:

- **Chrome extension** (`extension/`): for extraction. Log in to a bank yourself, then click **Extract**. The extension reads the transactions on the page (read-only), compares them with what's already saved by date and amount, shows a preview, and commits the result to your data repo.
- **Web dashboard** (`web/`): a static page hosted on GitHub Pages. It runs entirely in your browser and reads and writes the private data repo with a token you enter. It's for categories, notes, splits and, later, net worth and investments.

## Setup

1. **Create the data repo.** Make a new **private** GitHub repo, for example `finance-data`, and leave it empty.
2. **Create a token.** Go to GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   - Repository access: *Only select repositories* → `finance-data`
   - Permissions: *Contents: Read and write*. Metadata: read is added automatically.
3. **Load the extension.**
   - Open `chrome://extensions` and turn on *Developer mode*.
   - Click *Load unpacked* and pick the `extension/` folder.
   - Open the extension's **Options**, then enter the owner, repo and token.
   - Click **Test connection**, then **Initialize data repo**.
4. **Host the dashboard.**
   - Push this code repo to GitHub.
   - In that repo, go to Settings → Pages → Source and choose **GitHub Actions**.
   - `.github/workflows/pages.yml` deploys on every push to `main`. The page is at `https://<you>.github.io/<this-repo>/`.
   - Open the page, click **Settings ⚙**, and enter the same owner, repo and token. The page keeps them in its own browser storage.

After you edit the extension's code, reload it in `chrome://extensions`. To try the dashboard locally, start any static server from the repo root (for example `npx serve .`) and open `/web/`.

## Using it

- **Extract** (extension): runs the extractor that matches the site, detects the account and compares with what's saved. Then click **Save**.
- **Capture** (extension): downloads a stripped copy of the page's structure, with no scripts, amounts scrambled and account numbers masked. New site extractors are written from these captures. Put them in `samples/<institution>/`, which is gitignored.
- **Dashboard** (web): edit categories, notes and splits.
  - Changes show instantly and are saved to GitHub as one commit about a minute later, or right away with **Save now**.
  - Drag the ☰ handles to reorder categories or move them between groups.
  - **Predictions** (Summary): under each category's actual row is a prediction row with a box for every month, so actual and predicted sit side by side. Type in **Monthly** (the last column) to fill and lock all 12 months, or leave it blank and enter single months (one-offs); the average is their total over 12. **Predicted / mo** shows the result, and the **Predictions** button hides the extra rows. Predicted numbers are orange.
  - **Financial year**: Nov–Oct by default, named by the year it ends in (2027 = Nov 2026 – Oct 2027). Change the start month in Settings.
  - **Group colors**: pick a color for each group in Edit categories; the Summary tints that group's rows.
  - **Archive**: a built-in category for things that shouldn't count, like card payments and transfers. Archived transactions are hidden from the summary and the list unless you filter to Archive.
  - **AI categorize** (button on the Transactions tab):
    - Filter the table to what you want categorized, add notes for the session if needed, and click **Categorize**.
    - The table then shows only the rows it would change, with an **After** column. Untick what you don't want, then **Apply**.
    - The AI keeps its own notes and proposes updates after each session, which you approve. Tick **One-time only** for things it shouldn't remember.
    - Tick **Notes only** to just teach it something: nothing is categorized, and you approve the change to its notes.
    - Past sessions are on the **Logs** tab.
    - It uses Claude Haiku by default (cheap; costs are shown). Add your Anthropic API key in Settings.
  - **Counted amount**: in a transaction's expanded row, count it as a different amount, e.g. $0 if it was reimbursed, or just your share. The bank amount is kept.
  - **Bulk categories**:
    - On Transactions, drag down the Category column (the blank strip left of each dropdown) to select several rows. Shift-click extends the selection and Ctrl-click adds a single row.
    - Ctrl+C copies a category and Ctrl+V pastes it into everything selected, instantly. Delete clears, Ctrl+Z undoes, Esc clears the selection.
  - **Backup** (Settings → **Export all data**): downloads a .zip of every file in the data repo plus the browser-only state (AI log, unsaved edits, connection settings). It never includes your token or API key. The zip's README explains how to restore it into a new private repo.

## Privacy and safety

- The extension uses `activeTab`, so it can only see a bank page when you click its button. It has no standing access to any bank site.
- Content scripts only read the DOM. They never click, type or submit anything.
- **No financial data ever goes into this code repo or onto the Pages site.** The site is only code. Your transactions are fetched from the private data repo by your browser, using your token.
- Your token is stored in browser storage: `chrome.storage.local` for the extension and `localStorage` for the dashboard site. It is never written to a repo.
  - On the web, every Pages site under your `github.io` address shares that storage. Don't host untrusted pages there.
  - Use a fine-grained token limited to the data repo. **Forget token** in Settings removes it from the browser.
- The dashboard's Content-Security-Policy only lets the page talk to `api.github.com` and `api.anthropic.com`. AI categorize sends only the transactions you select: date, amount, description, note and category.
- The extension and the dashboard both refuse to use a data repo that is public.

## Development

```
npm test          # parsing, dedupe, store, outbox, and the dashboard driven in jsdom (Node 20+)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and [DATA_LAYOUT.md](DATA_LAYOUT.md) for the data schema.

## Roadmap

- [x] Extension skeleton, GitHub storage, atomic commits, dedupe/preview
- [x] Page capture tool for writing extractors
- [x] Wells Fargo extractor, checking and credit card
- [x] Web dashboard on GitHub Pages: categories, notes, splits, buffered saves
- [ ] Ally extractor, checking and credit card
- [x] AI categorize: user-directed, rule-based suggestions with before/after review (Claude Haiku)
- [x] AI notes that grow from sessions (with one-time-only sessions)
- [ ] Balance snapshots → net worth over time
- [ ] Fidelity (Roth IRA), Ascensus, 401k, HSA: holdings and contribution extractors
- [ ] Investment tracker: positions, cost basis, money-weighted return (XIRR), allocation vs. target, DCA suggestions

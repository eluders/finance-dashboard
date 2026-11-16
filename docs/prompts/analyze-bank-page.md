# Prompt: analyze a bank page for extractor development

Use this with claude.ai if you'd rather not drop the capture file into this repo.
Attach the `fd-capture-*.html` file (from the extension's **Capture page for analysis** button),
then paste everything below the line. Copy Claude's full response back into Claude Code.

---

I'm writing a Chrome extension content script that reads transactions from this bank page (read-only DOM scraping, run only when I click a button). The attached file is a sanitized capture of the page's DOM: scripts/styles removed, open shadow roots inlined as `<fd-shadow-root>`, same-origin iframes inlined as `<fd-iframe-doc>`, invisible elements marked `data-fd-hidden="1"`. Dollar amounts have had their digits randomized and long numbers zeroed, but formats are preserved.

Analyze the structure and report the following. Be exact: quote real tag names, attributes and class names from the file, and give example snippets.

1. **Page type & variants**: which account type this is (checking/savings/credit card), and anything suggesting the layout differs by account type.
2. **Account header**: where the account name, last-4 digits, current balance, and available balance/credit live (selectors + example text).
3. **Transaction container(s)**: the element(s) holding the list. Are pending and posted transactions in separate sections? How is each section labeled?
4. **Row selector**: a selector that matches exactly one element per transaction and nothing else. Say how many rows it matches in this file, and how many transactions you count by eye.
5. **Fields per row**, with a selector relative to the row and example raw text for each:
   - transaction date (and posted date if separate), with exact format
   - description/merchant (is there a short name and a longer detail?)
   - amount: one signed column, or separate debit/credit columns? How is the sign shown (minus sign, parentheses, color/class, column)?
   - running balance (if present — must be ignored)
   - pending indicator
   - anything else useful (category, check number, reference id)
6. **Selector stability**: which classes/attributes look stable (semantic names, `data-*`, `aria-*`, roles) vs. generated hashes likely to change between deployments. Prefer stable ones; offer a fallback for each.
7. **Expandable rows / pagination**: are details hidden until a row is expanded? Is there a "load more"/pagination control, and how many transactions does the page show by default? (The script must not click anything; just tell me what's there.)
8. **Shadow DOM / iframes**: are the transactions inside a shadow root or iframe? Which host element?
9. **Edge cases** you notice: multi-line descriptions, foreign currency, refunds, transfers, dates without years, date group headers (e.g. rows grouped under a "Nov 12" heading instead of each row having a date).

Finish with a **JSON summary** in this shape:

```json
{
  "accountType": "",
  "accountHeader": { "name": "", "last4": "", "balance": "", "availableBalance": "" },
  "sections": [{ "label": "", "containerSelector": "", "status": "pending|posted" }],
  "rowSelector": "",
  "rowCountInFile": 0,
  "fields": {
    "date": { "selector": "", "format": "" },
    "description": { "selector": "" },
    "amount": { "selector": "", "signConvention": "" },
    "debit": { "selector": "" },
    "credit": { "selector": "" },
    "balance": { "selector": "" },
    "pending": { "how": "" }
  },
  "dateGroupHeaders": false,
  "shadowRootHost": null,
  "pagination": "",
  "unstableSelectorsToAvoid": [],
  "notes": ""
}
```

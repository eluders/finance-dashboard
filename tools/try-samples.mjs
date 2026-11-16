// Runs extractors over local page captures in samples/ (gitignored) and prints a summary.
// Usage: node tools/try-samples.mjs [samples/wellsfargo] [--rows]
import fs from "node:fs";
import path from "node:path";
import { runExtractor } from "../tests/helpers/run-extractor.mjs";

const args = process.argv.slice(2);
const showRows = args.includes("--rows");
const dir = args.find((a) => !a.startsWith("--")) || "samples";

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) files.push(p);
  }
})(dir);

const money = (c) => (c < 0 ? "-" : "+") + "$" + (Math.abs(c) / 100).toFixed(2);
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const url = (html.match(/^url: (.+)$/m) || [])[1] || "https://example.com/";
  const r = runExtractor(html, url);
  console.log(`\n=== ${path.basename(f)}`);
  if (!r.ok) { console.log("ERROR", r.error); continue; }
  const pend = r.transactions.filter((t) => t.status === "pending").length;
  const pos = r.transactions.filter((t) => t.amountCents > 0).length;
  console.log(`${r.extractorId}/${r.method}  account=${JSON.stringify(r.account)}  balance=${r.balanceCents != null ? money(r.balanceCents) : "?"} (${r.balanceLabel})`);
  console.log(`${r.transactions.length} txns: ${pend} pending, ${pos} money-in, ${r.transactions.length - pos} money-out, ${r.transactions.filter((t) => t.bankRef).length} with bankRef`);
  for (const w of r.warnings) console.log("  ! " + w);
  if (showRows) for (const t of r.transactions) console.log(`  ${t.date} ${t.postedDate || "          "} ${t.status.padEnd(7)} ${money(t.amountCents).padStart(11)}  ${t.description.slice(0, 60)}${t.bankRef ? "  [" + t.bankRef + "]" : ""}`);
}

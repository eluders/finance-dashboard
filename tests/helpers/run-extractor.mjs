// Runs the extension's content scripts against an HTML string in jsdom, the same way
// the popup injects them, and returns run-extract.js's result.
import fs from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../../extension/", import.meta.url);
const FILES = [
  "src/content/common.js",
  "src/content/extractors/generic.js",
  "src/content/extractors/wellsfargo.js",
  "src/content/run-extract.js",
];
const sources = FILES.map((f) => fs.readFileSync(new URL(f, root), "utf8"));

export function runExtractor(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  let result;
  for (const src of sources) result = dom.window.eval(src);
  dom.window.close();
  // Chrome serializes executeScript results; doing the same also drops jsdom's foreign-realm prototypes
  return JSON.parse(JSON.stringify(result));
}

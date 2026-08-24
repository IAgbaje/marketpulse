/**
 * Bundle-size gate.
 *
 * Technical Requirements §9 makes "<=300KB gzipped on the initial route" a ship
 * gate, and §12 explains why: this product is used on metered data over
 * variable Nigerian networks. Measured in CI so it is caught on the commit
 * that causes it, not on a real device months later.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGET_BYTES = 300 * 1024;
const ASSET_DIR = "dist/assets";

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const jsFiles = walk(ASSET_DIR).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error(`No JS emitted in ${ASSET_DIR} — did the build run?`);
  process.exit(1);
}

let total = 0;
for (const file of jsFiles) {
  const size = gzipSync(readFileSync(file)).length;
  total += size;
  console.log(`  ${file}  ${(size / 1024).toFixed(2)} kB gzipped`);
}

const kb = (total / 1024).toFixed(2);
const budgetKb = (BUDGET_BYTES / 1024).toFixed(0);

if (total > BUDGET_BYTES) {
  console.error(`\nFAIL: initial JS is ${kb} kB gzipped, over the ${budgetKb} kB budget.`);
  console.error("Lazy-load per route (charts, map) before raising this number.");
  process.exit(1);
}

console.log(`\nOK: ${kb} kB gzipped, within the ${budgetKb} kB budget.`);

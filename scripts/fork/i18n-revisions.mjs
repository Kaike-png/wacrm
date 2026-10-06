#!/usr/bin/env node
/**
 * Pin the fork's translation revisions to the current upstream text.
 *
 *   node scripts/fork/i18n-revisions.mjs [--check] [locale=pt]
 *
 * src/custom/i18n/revisions/<locale>.json      reviewed strings (nested)
 * src/custom/i18n/revisions/<locale>.base.json upstream text each one replaces (flat)
 *
 * Without flags: rewrites <locale>.base.json from messages/<locale>.json
 * for every revised key. Run it only AFTER reviewing the upstream change
 * that made `revisions.test.ts` fail (docs/LOCALIZATION.md → "Merges do
 * upstream"). With --check: prints the keys whose upstream text changed
 * (old → new) and exits 1 if any, without writing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const locale = args.find((a) => !a.startsWith('--')) ?? 'pt';
const root = process.cwd();
const dir = join(root, 'src', 'custom', 'i18n', 'revisions');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const flatten = (node, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};

const core = flatten(read(join(root, 'messages', `${locale}.json`)));
const revisions = flatten(read(join(dir, `${locale}.json`)));
const basePath = join(dir, `${locale}.base.json`);
const base = read(basePath);

const changed = [];
const missing = [];
const next = {};
for (const key of Object.keys(revisions).sort()) {
  if (!(key in core)) {
    missing.push(key);
    continue;
  }
  if (base[key] !== undefined && base[key] !== core[key]) {
    changed.push({ key, from: base[key], to: core[key], ours: revisions[key] });
  }
  next[key] = core[key];
}

for (const key of missing)
  console.log(
    `missing in messages/${locale}.json: ${key} (remove the revision)`
  );
for (const c of changed) {
  console.log(
    `\n${c.key}\n  upstream before: ${c.from}\n  upstream now:    ${c.to}\n  our revision:    ${c.ours}`
  );
}

if (check) {
  process.exit(changed.length || missing.length ? 1 : 0);
}
if (missing.length) {
  console.error(
    '\nRemove the revisions for keys that no longer exist, then re-run.'
  );
  process.exit(1);
}
writeFileSync(basePath, `${JSON.stringify(next, null, 2)}\n`);
console.log(
  `\n${Object.keys(next).length} revisions pinned (${changed.length} re-pinned) → ${basePath}`
);

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_PATCHES } from './core-patches';

/**
 * Layering guard for the fork (see docs/UPSTREAM_STRATEGY.md).
 *
 *   core          everything upstream owns (src/** outside the layers below)
 *   custom        src/custom          product layer + core facade + seams
 *   billing       src/billing         plans, subscriptions, quotas
 *   modules       src/modules/<name>  feature modules (src/modules/br first)
 *   integrations  src/integrations    adapters to third-party systems
 *   fork-app      src/app/**\/(fork)/  fork route files (composition roots)
 *
 * Allowed dependency direction (→ = "may import"):
 *   custom       → core
 *   billing      → core, custom
 *   modules      → core, custom, billing
 *   integrations → core, custom, billing, modules
 *   fork-app     → everything
 *   core         → nothing in the fork, except registered seams
 *                  (src/custom/core-patches.ts)
 *
 * Outside src/custom, core server/client APIs are reached through the
 * facade (src/custom/core/*), never via src/lib/** or src/app/**
 * directly. UI building blocks (components, hooks, types) and
 * src/lib/utils.ts are exempt: they are presentational and churn less.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

type Layer =
  'core' | 'custom' | 'billing' | 'modules' | 'integrations' | 'fork-app';

const ALLOWED: Record<Layer, Layer[]> = {
  core: ['core'],
  custom: ['core', 'custom'],
  billing: ['core', 'custom', 'billing'],
  modules: ['core', 'custom', 'billing', 'modules'],
  integrations: ['core', 'custom', 'billing', 'modules', 'integrations'],
  'fork-app': [
    'core',
    'custom',
    'billing',
    'modules',
    'integrations',
    'fork-app',
  ],
};

function layerOf(rel: string): Layer {
  if (rel.startsWith('src/custom/')) return 'custom';
  if (rel.startsWith('src/billing/')) return 'billing';
  if (rel.startsWith('src/modules/')) return 'modules';
  if (rel.startsWith('src/integrations/')) return 'integrations';
  if (rel.startsWith('src/app/') && rel.includes('/(fork)/')) return 'fork-app';
  return 'core';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

/** Repo-relative path a specifier points to, or null for packages. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith('@/')) target = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return null;
  return relative(ROOT, target).split('\\').join('/');
}

function isFacadeExempt(target: string): boolean {
  if (!target.startsWith('src/lib/') && !target.startsWith('src/app/')) {
    return true; // components, hooks, types, i18n, … are fine
  }
  return target === 'src/lib/utils' || target.startsWith('src/lib/utils.');
}

interface Edge {
  from: string;
  to: string;
}

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const file of walk(SRC)) {
    const from = relative(ROOT, file).split('\\').join('/');
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const to = resolveSpecifier(file, match[1]);
      if (to) edges.push({ from, to });
    }
  }
  return edges;
}

const edges = collectEdges();
// A core file may carry several patches (e.g. P-002 and P-004 in request.ts).
const registeredFiles = new Map<string, (typeof CORE_PATCHES)[number][]>();
for (const p of CORE_PATCHES) {
  for (const f of p.files)
    registeredFiles.set(f, [...(registeredFiles.get(f) ?? []), p]);
}

describe('fork architecture', () => {
  it('finds source files to check (sanity)', () => {
    expect(edges.length).toBeGreaterThan(1000);
  });

  it('layers only import in the allowed direction', () => {
    const violations = edges
      .filter(({ from, to }) => {
        const fromLayer = layerOf(from);
        const toLayer = layerOf(to);
        if (ALLOWED[fromLayer].includes(toLayer)) return false;
        if (fromLayer !== 'core') return true;
        // Core → fork is allowed only through a registered seam.
        const patches = registeredFiles.get(from) ?? [];
        return !patches.some((p) =>
          p.seams.some((seam) => to.startsWith(seam))
        );
      })
      .map(({ from, to }) => `${from} → ${to}`);
    expect(violations).toEqual([]);
  });

  it('fork code outside src/custom reaches core APIs via the facade', () => {
    const violations = edges
      .filter(({ from, to }) => {
        const fromLayer = layerOf(from);
        if (fromLayer === 'core' || fromLayer === 'custom') return false;
        return layerOf(to) === 'core' && !isFacadeExempt(to);
      })
      .map(({ from, to }) => `${from} → ${to} (use src/custom/core/*)`);
    expect(violations).toEqual([]);
  });

  it('every FORK-PATCH marker in core is registered, and vice versa', () => {
    const marked = new Map<string, Set<string>>();
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (layerOf(rel) !== 'core') continue;
      for (const m of readFileSync(file, 'utf8').matchAll(
        /FORK-PATCH\((P-\d{3})\)/g
      )) {
        if (!marked.has(rel)) marked.set(rel, new Set());
        marked.get(rel)!.add(m[1]);
      }
    }

    const unregistered = [...marked.entries()]
      .filter(([file, ids]) =>
        [...ids].some(
          (id) => !registeredFiles.get(file)?.some((p) => p.id === id)
        )
      )
      .map(([file, ids]) => `${file} (${[...ids].join(', ')})`);
    expect(unregistered).toEqual([]);

    const unmarked = [...registeredFiles.entries()]
      .flatMap(([file, patches]) =>
        patches.map((patch) => [file, patch] as const)
      )
      .filter(
        ([file, patch]) =>
          !readFileSync(join(ROOT, file), 'utf8').includes(
            `FORK-PATCH(${patch.id})`
          )
      )
      .map(([file, patch]) => `${file} (${patch.id})`);
    expect(unmarked).toEqual([]);
  });

  it('patch ids are unique and registered files exist', () => {
    const ids = CORE_PATCHES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missing = CORE_PATCHES.flatMap((p) => p.files).filter(
      (f) => !existsSync(join(ROOT, f))
    );
    expect(missing).toEqual([]);
  });
});

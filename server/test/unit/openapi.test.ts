import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../helpers/testApp.js';

/** Collects "METHOD /path" for every route registered on the Express app (router stack walk). */
function listRoutes(app: unknown): string[] {
  const out = new Set<string>();
  const walk = (stack: unknown[], prefix: string) => {
    for (const layer of stack as Array<Record<string, unknown>>) {
      const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
      if (route) {
        for (const m of Object.keys(route.methods)) out.add(`${m.toUpperCase()} ${prefix}${route.path}`);
        continue;
      }
      const handle = layer.handle as { stack?: unknown[] } | undefined;
      if (handle?.stack) {
        // Express 5 stores a mount path on the layer (string or regexp); only '/api/v1' is a real prefix here.
        const p = typeof layer.path === 'string' ? layer.path : '';
        walk(handle.stack, prefix + p);
      }
    }
  };
  walk(((app as { router: { stack: unknown[] } }).router ?? (app as { _router: { stack: unknown[] } })._router).stack, '');
  return [...out];
}

describe('openapi.yaml', () => {
  it('documents exactly the routes mounted on the app', async () => {
    const ctx = await createTestContext();
    try {
      const spec = readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8');
      const documented = new Set<string>();
      let current: string | null = null;
      for (const line of spec.split('\n')) {
        const p = /^  (\/[^\s:]*):\s*$/.exec(line);
        if (p) current = p[1] ?? null;
        const m = /^    (get|post|patch|delete):\s*$/.exec(line);
        if (m && current) documented.add(`${m[1]?.toUpperCase()} ${current}`);
      }
      const mounted = listRoutes(ctx.app)
        .map((r) => r.replace(/^([A-Z]+) \/api\/v1/, '$1 ').replace(':id', '{id}'))
        .filter((r) => r.startsWith('GET ') || r.startsWith('POST ') || r.startsWith('PATCH ') || r.startsWith('DELETE '));
      expect([...documented].sort()).toEqual([...new Set(mounted)].sort());
    } finally {
      await ctx.close();
    }
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { exportStatic } from './index.js';

describe('static export', () => {
  it('writes deterministic content-addressed routes and a provenance manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-export-'));
    try {
      const ir = createFixtureIR();
      const rendered = renderDesign(ir);
      const result = await exportStatic(rendered, ir, root);
      expect(result.directory).toContain(result.digest);
      expect(JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8')).irHash).toBe(rendered.irHash);
      expect(await readFile(join(result.directory, 'index.html'), 'utf8')).toBe(rendered.routes[0]!.html);
      expect(await readFile(join(result.directory, 'proof', 'index.html'), 'utf8')).toBe(rendered.routes[1]!.html);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses assets without a license record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-export-'));
    try {
      const ir = createFixtureIR();
      ir.assets.items[0]!.provenance.license = '';
      await expect(exportStatic(renderDesign(ir), ir, root)).rejects.toThrow(/license/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

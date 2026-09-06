import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportStatic } from '@pwb/export';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { createPreviewServer } from './preview.js';

describe('preview origin', () => {
  it('serves the exact route bytes written by static export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-preview-'));
    const rendered = renderDesign(createFixtureIR());
    const exported = await exportStatic(rendered, createFixtureIR(), root);
    const preview = createPreviewServer(() => rendered, 4312);
    await preview.start();
    try {
      const response = await fetch(`${preview.origin}/preview/v0/proof`);
      expect(await response.text()).toBe(await readFile(join(exported.directory, 'proof', 'index.html'), 'utf8'));
      expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:5173 http://127.0.0.1:4173');
    } finally { await preview.close(); await rm(root, { recursive: true, force: true }); }
  });
});

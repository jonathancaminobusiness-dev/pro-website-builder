import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportStatic } from '@pwb/export';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { createPreviewServer } from './preview.js';

async function rawRequestStatus(port: number, requestLine: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`); });
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    socket.on('end', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('preview origin', () => {
  it('serves the exact route bytes written by static export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-preview-'));
    const rendered = renderDesign(createFixtureIR());
    const exported = await exportStatic(rendered, createFixtureIR(), root);
    const preview = createPreviewServer((versionId) => versionId === 'v0' ? rendered : undefined, 4312);
    await preview.start();
    try {
      const response = await fetch(`${preview.origin}/preview/v0/proof`);
      expect(await response.text()).toBe(await readFile(join(exported.directory, 'proof', 'index.html'), 'utf8'));
      expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:5173');
      expect((await fetch(`${preview.origin}/preview/v-other/proof`)).status).toBe(404);
      const malformed = await fetch(`${preview.origin}/preview/v0/%`);
      expect(malformed.status).toBe(404);
      expect(await rawRequestStatus(4312, 'GET http://user@:80/ HTTP/1.1')).toContain('400');
      expect((await fetch(`${preview.origin}/preview/v0/proof`)).status).toBe(200);
    } finally { await preview.close(); await rm(root, { recursive: true, force: true }); }
  });
});

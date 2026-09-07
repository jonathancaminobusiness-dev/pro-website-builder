import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
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

  it('keeps a link inside the prefix the revision is reviewed under, and at the site root once exported', async () => {
    const ir = createFixtureIR();
    const home = ir.pages.routes[0]!;
    home.nodes.push({ id: 'home-cta', kind: 'component', semantic: 'link', props: { text: 'Ver a prova', href: '/proof', color: '{color.ink}', font: '{type.body}' }, slots: {}, responsive: [] });
    home.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'home-cta'] };
    const proof = ir.pages.routes[1]!;
    proof.nodes.push({ id: 'proof-cta', kind: 'component', semantic: 'link', props: { text: 'Voltar ao início', href: '/', color: '{color.ink}', font: '{type.body}' }, slots: {}, responsive: [] });
    proof.nodes[0]!.slots = { children: ['proof-title', 'proof-cta'] };

    const versionId = 'v-link';
    const reviewed = renderDesign(ir, { routePrefix: `/preview/${versionId}` });
    const preview = createPreviewServer((requested) => requested === versionId ? reviewed : undefined, 0);
    await preview.start();
    const origin = `http://127.0.0.1:${(preview.server.address() as AddressInfo).port}`;
    try {
      const hrefOn = async (route: string): Promise<string> => {
        const response = await fetch(`${origin}/preview/${versionId}${route}`);
        expect(response.status).toBe(200);
        return /<a href="([^"]+)"/.exec(await response.text())![1]!;
      };
      const forward = await hrefOn('/');
      expect(forward).toBe(`/preview/${versionId}/proof`);
      expect((await fetch(new URL(forward, origin))).status).toBe(200);

      const back = await hrefOn('/proof');
      expect(back).toBe(`/preview/${versionId}/`);
      expect((await fetch(new URL(back, origin))).status).toBe(200);

      // The exported site owns the root, so the same document links there without the review prefix.
      expect(renderDesign(ir).routes[0]!.html).toContain('href="/proof"');
    } finally { await preview.close(); }
  });
});

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

const FACE_BYTES = Buffer.from([119, 79, 70, 50, 4, 3, 2, 1]);
const REPLACED_BYTES = Buffer.from([119, 79, 70, 50, 9, 9, 9, 9, 9]);
const MANIFEST = JSON.stringify({
  faces: [{
    family: 'Fixture Sans', weight: '400', style: 'normal', format: 'woff2', file: 'fixture-sans-400.woff2',
    license: 'ofl-1.1', source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07',
  }],
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fontsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pwb-preview-fonts-'));
  directories.push(directory);
  await writeFile(join(directory, 'fixture-sans-400.woff2'), FACE_BYTES);
  return directory;
}

describe('preview origin', () => {
  it('serves the faces the release self-hosts, so the captain reviews the published typography', async () => {
    const rendered = renderDesign(createFixtureIR());
    const fontsDir = await fontsDirectory();
    const preview = createPreviewServer((versionId) => versionId === 'v0' ? rendered : undefined, 0, fontsDir);
    await preview.start();
    try {
      // Nothing served yet: the origin answers for no face at all.
      expect(preview.servedFaces()).toBeUndefined();
      // No manifest yet: the preview is exactly the bytes the renderer produced.
      expect(await (await fetch(`${preview.origin}/preview/v0/`)).text()).toBe(rendered.routes.find((route) => route.route === '/')!.html);
      // That document declared no face, which is what it reports.
      expect(preview.servedFaces()).toEqual([]);

      // A face the owner adds while the studio runs reaches the iframe.
      await writeFile(join(fontsDir, 'manifest.json'), MANIFEST, 'utf8');
      const document = await (await fetch(`${preview.origin}/preview/v0/`)).text();
      const href = /src:url\("([^"]+)"\)/.exec(document)?.[1];
      expect(document).toContain('@font-face{font-family:"Fixture Sans";');
      expect(href).toMatch(/^\/assets\/fonts\/fixture-sans-400-normal\.[0-9a-f]{12}\.woff2$/);

      const face = await fetch(`${preview.origin}${href!}`);
      expect(face.status).toBe(200);
      expect(face.headers.get('content-type')).toBe('font/woff2');
      expect(Buffer.from(await face.arrayBuffer())).toEqual(FACE_BYTES);
      // The policy has to allow what the origin now serves.
      expect(face.headers.get('content-security-policy')).toContain("font-src 'self'");
      expect((await fetch(`${preview.origin}/assets/fonts/absent.woff2`)).status).toBe(404);

      // Re-exporting a face in place leaves the manifest untouched, and the
      // release would compile the new bytes: the next document has to declare
      // them, or the captain approves a typeface the site never ships.
      await writeFile(join(fontsDir, 'fixture-sans-400.woff2'), REPLACED_BYTES);
      const updated = await (await fetch(`${preview.origin}/preview/v0/`)).text();
      const next = /src:url\("([^"]+)"\)/.exec(updated)?.[1];
      expect(next).not.toBe(href);
      const replaced = await fetch(`${preview.origin}${next!}`);
      expect(replaced.status).toBe(200);
      expect(Buffer.from(await replaced.arrayBuffer())).toEqual(REPLACED_BYTES);
      expect(preview.servedFaces()?.map((decision) => decision.path)).toEqual([next!.replace(/^\//, '')]);

      // Neither a route this origin does not have nor a font file is a document
      // that left it, so neither answers for a face.
      expect((await fetch(`${preview.origin}/preview/absent/`)).status).toBe(404);
      expect((await fetch(`${preview.origin}/preview/v0/absent`)).status).toBe(404);
      expect((await fetch(`${preview.origin}${next!}`)).status).toBe(200);
      expect(preview.servedFaces()?.map((decision) => decision.path)).toEqual([next!.replace(/^\//, '')]);

      // The face URL is content-addressed, so the document the captain is
      // already looking at keeps answering with the bytes it declared.
      const again = await fetch(`${preview.origin}${href!}`);
      expect(again.status).toBe(200);
      expect(Buffer.from(await again.arrayBuffer())).toEqual(FACE_BYTES);
    } finally { await preview.close(); }
  });

  it('fails the preview request, not the studio, when the fonts of the project cannot be read', async () => {
    const rendered = renderDesign(createFixtureIR());
    const fontsDir = await fontsDirectory();
    await writeFile(join(fontsDir, 'manifest.json'), '{ not json', 'utf8');
    const preview = createPreviewServer((versionId) => versionId === 'v0' ? rendered : undefined, 0, fontsDir);
    await preview.start();
    try {
      const refused = await fetch(`${preview.origin}/preview/v0/`);
      expect(refused.status).toBe(500);
      // The origin is still up; only this request failed.
      expect((await fetch(`${preview.origin}/preview/v0/`)).status).toBe(500);
      // Correcting the manifest fixes the next request without a restart.
      await writeFile(join(fontsDir, 'manifest.json'), MANIFEST, 'utf8');
      expect((await fetch(`${preview.origin}/preview/v0/`)).status).toBe(200);
    } finally { await preview.close(); }
  });

  it('serves the exact route bytes the deterministic renderer produced', async () => {
    const rendered = renderDesign(createFixtureIR());
    const preview = createPreviewServer((versionId) => versionId === 'v0' ? rendered : undefined, 0);
    await preview.start();
    const port = (preview.server.address() as AddressInfo).port;
    try {
      const response = await fetch(`${preview.origin}/preview/v0/proof`);
      expect(await response.text()).toBe(rendered.routes.find((route) => route.route === '/proof')!.html);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:5173');
      expect((await fetch(`${preview.origin}/preview/v-other/proof`)).status).toBe(404);
      const malformed = await fetch(`${preview.origin}/preview/v0/%`);
      expect(malformed.status).toBe(404);
      expect(await rawRequestStatus(port, 'GET http://user@:80/ HTTP/1.1')).toContain('400');
      expect((await fetch(`${preview.origin}/preview/v0/proof`)).status).toBe(200);
    } finally { await preview.close(); }
  });

  it('reports a port it cannot bind instead of waiting forever on it', async () => {
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    const taken = (held.address() as AddressInfo).port;
    const preview = createPreviewServer(() => undefined, taken);
    try {
      await expect(preview.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally { await new Promise<void>((resolve, reject) => held.close((error) => error ? reject(error) : resolve())); }
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

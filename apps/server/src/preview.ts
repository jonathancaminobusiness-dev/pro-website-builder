import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fontFaceCss, selfHostFaces, type FontSource } from '@pwb/export';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer { server: Server; origin: string; start(): Promise<void>; close(): Promise<void>; }

/**
 * The origin the captain reviews.
 *
 * It serves the same faces the release ships, from the same file names, because
 * a preview rendered in the browser's fallback would show the captain a
 * typeface the published site does not use. Everything else is exactly the
 * bytes the renderer produced.
 */
export function createPreviewServer(getRendered: (versionId: string) => RenderedDocument | undefined, port = 4311, fonts: FontSource[] = []): PreviewServer {
  const faces = selfHostFaces(fonts, (bytes) => createHash('sha256').update(bytes).digest('hex'));
  const faceFiles = new Map(faces.files.map((file) => [file.path, Buffer.from(file.contents)]));
  const faceCss = fontFaceCss(faces.decisions, (decision) => `/${decision.path}`);
  const withFaces = (html: string): string => faceCss === '' ? html : html.replace('</head>', `<style>${faceCss}</style></head>`);

  const server = createServer((request, response) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', PREVIEW_ORIGIN).pathname; }
    catch { response.writeHead(400, previewHeaders()).end('Malformed request target'); return; }
    const face = faceFiles.get(pathname.replace(/^\//, ''));
    if (face) { response.writeHead(200, { ...previewHeaders(), 'Content-Type': 'font/woff2' }).end(face); return; }
    const requested = /^\/preview\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!requested) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const document = getRendered(requested[1]!);
    if (!document) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const route = requested[2] || '/';
    const match = document.routes.find((candidate) => candidate.route === route);
    if (!match) { response.writeHead(404, previewHeaders()).end('Route unavailable'); return; }
    response.writeHead(200, previewHeaders()).end(withFaces(match.html));
  });
  return {
    server,
    // Read back from the socket, because a caller that asks for port 0 — as every script and test
    // does, so parallel checkouts never contend — only learns its port once the server is listening.
    get origin(): string {
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('The preview origin is only known once the server is listening.');
      return `http://127.0.0.1:${(address as AddressInfo).port}`;
    },
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

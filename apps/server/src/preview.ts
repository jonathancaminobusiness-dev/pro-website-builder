import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fontFaceCss, selfHostFaces, type FontSource } from '@pwb/export';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer { server: Server; origin: string; start(): Promise<void>; close(): Promise<void>; }

/**
 * The origin the captain reviews.
 *
 * It serves the same faces the release ships, from the same file names, because
 * a preview rendered in the browser's fallback would show the captain a
 * typeface the published site does not use. The faces are read when a document
 * is served, not once at start, so the preview shows what the release would ship
 * right now — and a manifest that cannot be read fails the preview rather than
 * the whole studio. Everything else is exactly the bytes the renderer produced.
 */
export function createPreviewServer(getRendered: (versionId: string) => RenderedDocument | undefined, port = 4311, loadFonts: () => Promise<FontSource[]> = async () => []): PreviewServer {
  const faces = async (): Promise<{ files: Map<string, Buffer>; css: string }> => {
    const plan = selfHostFaces(await loadFonts(), (bytes) => createHash('sha256').update(bytes).digest('hex'));
    return {
      files: new Map(plan.files.map((file) => [file.path, Buffer.from(file.contents)])),
      css: fontFaceCss(plan.decisions, (decision) => `/${decision.path}`),
    };
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', PREVIEW_ORIGIN).pathname; }
    catch { response.writeHead(400, previewHeaders()).end('Malformed request target'); return; }
    let plan: { files: Map<string, Buffer>; css: string };
    try { plan = await faces(); }
    catch (error) { response.writeHead(500, { ...previewHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }).end(error instanceof Error ? error.message : 'The fonts of this project could not be read.'); return; }
    const face = plan.files.get(pathname.replace(/^\//, ''));
    if (face) { response.writeHead(200, { ...previewHeaders(), 'Content-Type': 'font/woff2' }).end(face); return; }
    const requested = /^\/preview\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!requested) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const document = getRendered(requested[1]!);
    if (!document) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const route = requested[2] || '/';
    const match = document.routes.find((candidate) => candidate.route === route);
    if (!match) { response.writeHead(404, previewHeaders()).end('Route unavailable'); return; }
    response.writeHead(200, previewHeaders()).end(plan.css === '' ? match.html : match.html.replace('</head>', `<style>${plan.css}</style></head>`));
  };

  const server = createServer((request, response) => { void respond(request, response); });
  // The origin is read from the socket after it binds, so a caller may pass 0
  // and let the operating system choose a free port.
  const preview: PreviewServer = {
    server,
    origin: `http://127.0.0.1:${port}`,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') { reject(new Error('The preview server did not bind a TCP port.')); return; }
        preview.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  return preview;
}

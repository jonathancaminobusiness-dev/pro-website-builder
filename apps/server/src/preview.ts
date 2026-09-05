import { createServer, type Server } from 'node:http';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer { server: Server; origin: string; start(): Promise<void>; close(): Promise<void>; }

export function createPreviewServer(getRendered: () => RenderedDocument | undefined, port = 4311): PreviewServer {
  const server = createServer((request, response) => {
    const document = getRendered();
    if (!document) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const pathname = new URL(request.url ?? '/', PREVIEW_ORIGIN).pathname;
    const route = pathname.replace(/^\/preview\/[^/]+/, '') || '/';
    const match = document.routes.find((candidate) => candidate.route === decodeURIComponent(route));
    if (!match) { response.writeHead(404, previewHeaders()).end('Route unavailable'); return; }
    response.writeHead(200, previewHeaders()).end(match.html);
  });
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    start: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

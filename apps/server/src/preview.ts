import { createServer, type Server } from 'node:http';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer { server: Server; origin: string; start(): Promise<void>; close(): Promise<void>; }

export function createPreviewServer(getRendered: (versionId: string) => RenderedDocument | undefined, port = 4311): PreviewServer {
  const server = createServer((request, response) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', PREVIEW_ORIGIN).pathname; }
    catch { response.writeHead(400, previewHeaders()).end('Malformed request target'); return; }
    const requested = /^\/preview\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!requested) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const document = getRendered(requested[1]!);
    if (!document) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const route = requested[2] || '/';
    const match = document.routes.find((candidate) => candidate.route === route);
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

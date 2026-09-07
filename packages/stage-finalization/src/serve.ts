import { createServer, type Server } from 'node:http';
import type { CompiledSite } from '@pwb/export';
import type { RenderedDocument } from '@pwb/renderer';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
};

export interface ReleaseHarness {
  server: Server;
  /** Empty until `start()` resolves; pass port 0 to let the OS choose a free one. */
  origin: string;
  start(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Serves the compiled release and the preview of the same document side by
 * side, so an independent runner can compare them in a real browser instead of
 * taking the compiler's word for it.
 *
 * The release is served under the exact headers the bundle declares, including
 * the policy a `<meta>` tag is not allowed to carry, so the evidence is taken
 * against what the site would actually ship.
 */
export function createReleaseHarness(compiled: CompiledSite, rendered: RenderedDocument, port = 0): ReleaseHarness {
  const releaseFiles = new Map(compiled.files.map((file) => [file.path, file]));
  const previewDocuments = new Map(rendered.routes.map((route) => [route.route, route.html]));

  const server = createServer((request, response) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
    catch { response.writeHead(400, { 'content-type': 'text/plain' }).end('Malformed request target'); return; }

    if (pathname === '/harness.json') {
      const body = JSON.stringify({
        digest: compiled.digest,
        irHash: compiled.irHash,
        stylesheetPath: compiled.stylesheetPath,
        routes: compiled.routes.map((route) => ({ route: route.route, title: route.title, releasePath: `/release${route.route === '/' ? '/' : `${route.route}/`}`, previewPath: `/preview${route.route}` })),
      });
      response.writeHead(200, { 'content-type': CONTENT_TYPES.json! }).end(body);
      return;
    }

    if (pathname.startsWith('/preview')) {
      const route = pathname.slice('/preview'.length) || '/';
      const html = previewDocuments.get(route === '' ? '/' : route);
      if (html === undefined) { response.writeHead(404, { 'content-type': 'text/plain' }).end('Preview route unavailable'); return; }
      response.writeHead(200, { 'content-type': CONTENT_TYPES.html!, 'X-Content-Type-Options': 'nosniff' }).end(html);
      return;
    }

    // The release is served both at the root and under /release, because the
    // compiled documents link their assets from the site root exactly as a
    // static host would serve them.
    const relative = pathname.replace(/^\/release/, '').replace(/^\//, '');
    const candidate = relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative;
    const file = releaseFiles.get(candidate) ?? releaseFiles.get(`${candidate}/index.html`);
    if (!file) { response.writeHead(404, { 'content-type': 'text/plain', ...compiled.headers }).end('Not found'); return; }
    const extension = candidate.slice(candidate.lastIndexOf('.') + 1);
    const body = typeof file.contents === 'string' ? Buffer.from(file.contents, 'utf8') : Buffer.from(file.contents);
    response.writeHead(200, { 'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream', ...compiled.headers }).end(body);
  });

  const harness: ReleaseHarness = {
    server,
    origin: '',
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') { reject(new Error('The release harness did not bind a TCP port.')); return; }
        harness.origin = `http://127.0.0.1:${address.port}`;
        resolve(harness.origin);
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  return harness;
}

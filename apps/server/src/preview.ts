import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fontFaceCss, FONT_MANIFEST_FILE, loadFontSources, selfHostFaces } from '@pwb/export';
import { join } from 'node:path';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer { server: Server; origin: string; start(): Promise<void>; close(): Promise<void>; }

interface FacePlan { files: Map<string, Buffer>; css: string }
const NO_FACES: FacePlan = { files: new Map(), css: '' };

/**
 * The origin the captain reviews.
 *
 * It serves the same faces the release ships, from the same file names, because
 * a preview rendered in the browser's fallback would show the captain a
 * typeface the published site does not use. The manifest is read again whenever
 * it changes rather than once at start, so a face the owner adds while the
 * studio runs reaches the iframe and a manifest that cannot be read fails the
 * preview rather than the whole studio. The plan a document was rendered from is
 * kept, so the content-addressed faces that document declared stay served even
 * if the file behind one of them is replaced afterwards. Everything else is
 * exactly the bytes the renderer produced.
 */
export function createPreviewServer(getRendered: (versionId: string) => RenderedDocument | undefined, port = 4311, fontsDir?: string): PreviewServer {
  let cached: { key: string; plan: FacePlan } | undefined;

  const manifestKey = async (directory: string): Promise<string> => {
    try { const info = await stat(join(directory, FONT_MANIFEST_FILE)); return `${info.mtimeMs}:${info.size}`; }
    catch (error) { return error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT' ? 'absent' : 'unreadable'; }
  };

  const faces = async (): Promise<FacePlan> => {
    if (fontsDir === undefined) return NO_FACES;
    const key = await manifestKey(fontsDir);
    if (key !== 'unreadable' && cached?.key === key) return cached.plan;
    const built = selfHostFaces(await loadFontSources(fontsDir), (bytes) => createHash('sha256').update(bytes).digest('hex'));
    const plan: FacePlan = {
      files: new Map(built.files.map((file) => [file.path, Buffer.from(file.contents)])),
      css: fontFaceCss(built.decisions, (decision) => `/${decision.path}`),
    };
    if (key !== 'unreadable') cached = { key, plan };
    return plan;
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

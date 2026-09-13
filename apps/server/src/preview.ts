import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fontFaceCss, fontManifestKey, loadFontSources, parseFontFaceCss, selfHostFaces, type ServedFace } from '@pwb/export';
import type { RenderedDocument } from '@pwb/renderer';
import { PREVIEW_ORIGIN, previewHeaders } from './security.js';

export interface PreviewServer {
  server: Server;
  origin: string;
  /**
   * The faces the document of this version declared when this origin served it,
   * or `undefined` when it never served that version. They are read back out of
   * the bytes that left the origin, so a 404, a font file or another version
   * answers nothing, and Gate 3 comparing them against the compiled bundle is a
   * real comparison rather than the fonts directory against itself — nor one
   * version's document standing in for another's.
   */
  servedFaces(versionId: string): ServedFace[] | undefined;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface FacePlan { css: string }
const NO_FACES: FacePlan = { css: '' };

/**
 * The origin the captain reviews.
 *
 * It serves the same faces the release ships, from the same file names, because
 * a preview rendered in the browser's fallback would show the captain a
 * typeface the published site does not use. The faces are read again whenever
 * the manifest or any file it declares changes rather than once at start, so a
 * face the owner adds or re-exports while the studio runs reaches the iframe and
 * a manifest that cannot be read fails the preview rather than the whole studio.
 * Every face file the origin ever built stays served, so the content-addressed
 * faces a document already on screen declared do not turn into a 404 when the
 * file behind one of them is replaced. Everything else is exactly the bytes the
 * renderer produced.
 */
export function createPreviewServer(getRendered: (versionId: string) => RenderedDocument | undefined, port = 4311, fontsDir?: string): PreviewServer {
  let cached: { key: string; plan: FacePlan } | undefined;
  const served = new Map<string, ServedFace[]>();
  const built = new Map<string, Buffer>();

  const faces = async (): Promise<FacePlan> => {
    if (fontsDir === undefined) return NO_FACES;
    const key = await fontManifestKey(fontsDir);
    // The faces could not be identified, so nothing this origin served can still
    // be vouched for: the plan behind those documents is dropped along with the
    // record of having served them. Otherwise every request answers 500 while
    // `servedFaces` keeps handing Gate 3 a plan the preview no longer serves,
    // and the gate calls that a match.
    if (key === 'unreadable') { cached = undefined; served.clear(); }
    if (key !== 'unreadable' && cached?.key === key) return cached.plan;
    const hosted = selfHostFaces(await loadFontSources(fontsDir), (bytes) => createHash('sha256').update(bytes).digest('hex'));
    for (const file of hosted.files) built.set(file.path, Buffer.from(file.contents));
    const plan: FacePlan = { css: fontFaceCss(hosted.decisions, (decision) => `/${decision.path}`) };
    if (key !== 'unreadable') cached = { key, plan };
    return plan;
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', PREVIEW_ORIGIN).pathname; }
    catch { response.writeHead(400, previewHeaders()).end('Malformed request target'); return; }
    const face = built.get(pathname.replace(/^\//, ''));
    if (face) { response.writeHead(200, { ...previewHeaders(), 'Content-Type': 'font/woff2' }).end(face); return; }
    const requested = /^\/preview\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!requested) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const document = getRendered(requested[1]!);
    if (!document) { response.writeHead(404, previewHeaders()).end('Preview unavailable'); return; }
    const route = requested[2] || '/';
    const match = document.routes.find((candidate) => candidate.route === route);
    if (!match) { response.writeHead(404, previewHeaders()).end('Route unavailable'); return; }
    // Read after the route matched: only a document that really leaves this
    // origin may answer for the faces it declared.
    let plan: FacePlan;
    try { plan = await faces(); }
    catch (error) { response.writeHead(500, { ...previewHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }).end(error instanceof Error ? error.message : 'The fonts of this project could not be read.'); return; }
    const body = plan.css === '' ? match.html : match.html.replace('</head>', `<style>${plan.css}</style></head>`);
    served.set(requested[1]!, parseFontFaceCss(body, (url) => url.replace(/^\//, '')));
    response.writeHead(200, previewHeaders()).end(body);
  };

  const server = createServer((request, response) => { void respond(request, response); });
  // The origin is read from the socket after it binds, so a caller may pass 0
  // and let the operating system choose a free port.
  const preview: PreviewServer = {
    server,
    origin: `http://127.0.0.1:${port}`,
    servedFaces: (versionId) => served.get(versionId),
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

/**
 * A preview origin a command line run serves its own document from.
 *
 * Gate 3 compares the faces the captain was served against the faces the bundle
 * ships, and reads them from `servedFaces`, which answers only for the version
 * whose document this origin really delivered. A script has no studio, so it starts the same
 * origin on an ephemeral port and serves the version the stage hands the gate,
 * instead of the silence that used to read as parity.
 */
export interface ServedPreview extends PreviewServer {
  /** Serves one route of this document and answers the faces it declared. */
  serve(versionId: string, document: RenderedDocument): Promise<ServedFace[]>;
}

export async function startServedPreview(fontsDir?: string): Promise<ServedPreview> {
  const documents = new Map<string, RenderedDocument>();
  const preview = createPreviewServer((versionId) => documents.get(versionId), 0, fontsDir);
  await preview.start();
  return Object.assign(preview, {
    serve: async (versionId: string, document: RenderedDocument): Promise<ServedFace[]> => {
      documents.set(versionId, document);
      const route = document.routes[0]?.route ?? '/';
      const response = await fetch(`${preview.origin}/preview/${versionId}${route}`);
      if (!response.ok) throw new Error(`O preview não serviu a rota ${route} da versão ${versionId}: HTTP ${response.status}.`);
      await response.text();
      return preview.servedFaces(versionId) ?? [];
    },
  });
}

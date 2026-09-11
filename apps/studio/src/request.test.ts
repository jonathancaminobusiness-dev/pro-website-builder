import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyConnectionFailure, connectionFailureMessage, isMissing, RequestError, requestJson, waitForServer, waitingForServerMessage } from './request.js';

let running: Server | undefined;
afterEach(async () => {
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Ephemeral ports: several worktrees of this repo run their suites on one machine.
async function serve(answer: (response: ServerResponse) => void): Promise<string> {
  const server = createServer((_incoming, response) => answer(response));
  running = server;
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/identity/runs/one`;
}

/**
 * The screen decides whether to forget a remembered run and whether to keep
 * polling from what this helper throws, so what a failure carries is the
 * contract under test, not an implementation detail.
 */
describe('api request', () => {
  it('returns the parsed body of an answer the server accepted', async () => {
    const url = await serve((response) => { response.writeHead(200, { 'content-type': 'application/json' }).end('{"runId":"one"}'); });
    expect(await requestJson<{ runId: string }>(url)).toEqual({ runId: 'one' });
  });

  it('carries the status of a refusal, so a run that is gone is recognisable', async () => {
    const url = await serve((response) => { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Identity run not found."}'); });
    const cause = await requestJson(url).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(RequestError);
    expect((cause as RequestError).status).toBe(404);
    expect((cause as RequestError).message).toBe('Identity run not found.');
  });

  it('carries no status when nothing answered at all', async () => {
    // The server the url names is closed, which is what a restart looks like
    // from the tab: no answer, and therefore nothing said about the run.
    const url = await serve((response) => response.end());
    const server = running!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    running = undefined;

    const cause = await requestJson(url).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(RequestError);
    expect((cause as RequestError).status).toBeUndefined();
  });

  it('calls a run missing only when the server said so', async () => {
    const askOnce = async (answer: (response: ServerResponse) => void, closeFirst = false): Promise<unknown> => {
      const url = await serve(answer);
      const server = running!;
      if (closeFirst) { running = undefined; await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
      const cause = await requestJson(url).catch((error: unknown) => error);
      if (!closeFirst) { running = undefined; await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
      return cause;
    };

    expect(isMissing(await askOnce((response) => { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Identity run not found."}'); }))).toBe(true);
    // A refusal the server could not explain, and no answer at all, both leave
    // the question open: the run may still be there, so its id is worth keeping.
    expect(isMissing(await askOnce((response) => { response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'); }))).toBe(false);
    expect(isMissing(await askOnce((response) => response.end(), true))).toBe(false);
  });

  it('still reports a refusal whose body is not the JSON the api usually sends', async () => {
    const url = await serve((response) => { response.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>'); });
    const cause = await requestJson(url).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(RequestError);
    expect((cause as RequestError).status).toBe(502);
  });
});

/**
 * The captain sees one opaque console error for two very different situations,
 * and only one of them is fixed by waiting. The screen has to know which.
 */
describe('connection failure', () => {
  it('reports an unreachable API when nothing answers either probe', async () => {
    const url = await serve((response) => response.end());
    const server = running!;
    running = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await classifyConnectionFailure(url)).toBe('unreachable');
    const message = connectionFailureMessage('unreachable', url);
    expect(message).toContain(new URL(url).origin);
    expect(message).toContain('corepack pnpm --filter @pwb/server dev');
  });

  it('reports a refused origin only when the normal probe keeps failing', async () => {
    // Only a browser can answer one probe and refuse the other, so the probe is
    // supplied: the normal request is blocked by the origin check and the
    // opaque one completes, which is exactly what a real CORS refusal looks like.
    const refusing = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 204 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    expect(await classifyConnectionFailure('http://127.0.0.1:4310/api/identity/runs/one', refusing)).toBe('origin-refused');
    const message = connectionFailureMessage('origin-refused', 'http://127.0.0.1:4310/api/identity/runs/one', 'http://localhost:5173');
    expect(message).toContain('http://127.0.0.1:4310');
    expect(message).toContain('http://localhost:5173');
    expect(message).toContain('PWB_STUDIO_ORIGIN=http://localhost:5173');
  });

  it('does not accuse an origin when the server merely finished starting between probes', async () => {
    // The pair that means "refused" — normal probe fails, opaque probe answers —
    // is also what a restart produces, so an origin is accused only if the
    // normal probe fails a second time.
    let listening = false;
    const starting = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === 'no-cors') { listening = true; return new Response(null, { status: 204 }); }
      if (!listening) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    expect(await classifyConnectionFailure('http://127.0.0.1:4310/api/identity/runs/one', starting)).toBe('unknown');
  });

  it('keeps the neutral message when the API is reachable and welcomes this origin', async () => {
    // One request failed while `/health` answers: nothing was learned about the
    // server or the origin, so the screen must not accuse either of them.
    const url = await serve((response) => { response.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); });
    expect(await classifyConnectionFailure(url)).toBe('unknown');
    expect(connectionFailureMessage('unknown', url)).toBe('O servidor local não respondeu.');
  });
});

/**
 * The server builds its dependencies before it listens, so the Studio is
 * routinely open first. That window is waited out, not reported as a fault.
 */
describe('waiting for the API', () => {
  const waited: number[] = [];
  const sleep = async (ms: number): Promise<void> => { waited.push(ms); };

  it('keeps asking until the API starts listening, on a widening backoff', async () => {
    // Nothing answers at all for the first two rounds, which is what the
    // server's dependency build looks like from the tab.
    let rounds = 0;
    const probe = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === 'no-cors') throw new TypeError('Failed to fetch');
      rounds += 1;
      if (rounds <= 2) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    waited.length = 0;
    expect(await waitForServer('http://127.0.0.1:4310', { probe, sleep, firstDelayMs: 100, maxDelayMs: 400 })).toBe('ready');
    expect(waited).toEqual([100, 200]);
  });

  it('gives up after a bounded number of attempts and names the unreachable API', async () => {
    const probe = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    waited.length = 0;
    expect(await waitForServer('http://127.0.0.1:4310', { probe, sleep, attempts: 4, firstDelayMs: 100 })).toBe('unreachable');
    expect(waited).toHaveLength(3);
  });

  it('stops at once for a cause that waiting cannot fix', async () => {
    const refusing = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 204 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    waited.length = 0;
    expect(await waitForServer('http://127.0.0.1:4310', { probe: refusing, sleep })).toBe('origin-refused');
    expect(waited).toHaveLength(0);
  });

  it('names the origin it is waiting for', () => {
    expect(waitingForServerMessage('http://127.0.0.1:4310')).toContain('http://127.0.0.1:4310');
  });
});

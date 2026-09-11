import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyConnectionFailure, connectionFailureMessage, isMissing, RequestError, requestJson } from './request.js';

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
 * so the screen has to say which one happened and what to do about it.
 */
describe('connection failure', () => {
  it('names the API origin and the command when nothing is listening', async () => {
    const url = await serve((response) => response.end());
    const server = running!;
    running = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await classifyConnectionFailure(url)).toBe('unreachable');
    const cause = await requestJson(url).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(RequestError);
    expect((cause as RequestError).reason).toBe('unreachable');
    expect((cause as RequestError).message).toContain(new URL(url).origin);
    expect((cause as RequestError).message).toContain('corepack pnpm --filter @pwb/server dev');
  });

  it('names the refused origin and the single-origin remedy when the server is up', async () => {
    // Only a browser can answer one probe and refuse the other, so the probe is
    // supplied: the normal request is blocked by the origin check and the
    // opaque one completes, which is exactly what a real CORS refusal looks like.
    const probe = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 204 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    expect(await classifyConnectionFailure('http://127.0.0.1:4310/api/identity/runs/one', probe)).toBe('origin-refused');
    const message = connectionFailureMessage('origin-refused', 'http://127.0.0.1:4310/api/identity/runs/one', 'http://localhost:5173');
    expect(message).toContain('http://127.0.0.1:4310');
    expect(message).toContain('http://localhost:5173');
    expect(message).toContain('PWB_STUDIO_ORIGIN=http://localhost:5173');
  });

  it('keeps the neutral message when the API is reachable and welcomes this origin', async () => {
    // One request failed while `/health` answers: nothing was learned about the
    // server or the origin, so the screen must not accuse either of them.
    const url = await serve((response) => { response.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); });
    expect(await classifyConnectionFailure(url)).toBe('unknown');
    expect(connectionFailureMessage('unknown', url)).toBe('O servidor local não respondeu.');
  });
});

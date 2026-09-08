import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestError, requestJson } from './request.js';

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

  it('still reports a refusal whose body is not the JSON the api usually sends', async () => {
    const url = await serve((response) => { response.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>'); });
    const cause = await requestJson(url).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(RequestError);
    expect((cause as RequestError).status).toBe(502);
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HiggsfieldMcpProvider, McpToolTransport } from './index.js';

interface Received { method: string; params?: Record<string, unknown>; session?: string; protocol?: string }

/**
 * A fake MCP server. It speaks the same JSON-RPC the real one does, so what is
 * asserted here is the protocol the transport puts on the wire and the job it
 * builds from the answer, not the shape of a mock.
 */
function fakeMcpServer(answers: (method: string, params: Record<string, unknown> | undefined) => unknown, options: { sse?: boolean } = {}): { server: Server; received: Received[]; origin: () => string } {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: Record<string, unknown> };
      received.push({ method: message.method, ...(message.params ? { params: message.params } : {}), ...(request.headers['mcp-session-id'] ? { session: String(request.headers['mcp-session-id']) } : {}), ...(request.headers['mcp-protocol-version'] ? { protocol: String(request.headers['mcp-protocol-version']) } : {}) });
      const headers: Record<string, string> = { 'mcp-session-id': 'session-1' };
      if (message.id === undefined) { response.writeHead(202, headers).end(); return; }
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answers(message.method, message.params) });
      if (options.sse) { response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${body}\n\n`); return; }
      response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(body);
    });
  });
  return { server, received, origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

let running: Server | undefined;
afterEach(async () => {
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Ephemeral ports: several worktrees of this repo run their suites on one machine.
async function listen(fake: ReturnType<typeof fakeMcpServer>): Promise<string> {
  running = fake.server;
  await new Promise<void>((resolve) => { fake.server.listen(0, '127.0.0.1', resolve); });
  return fake.origin();
}

const generated = { structuredContent: { url: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.', cost: 4 } };

describe('mcp tool transport', () => {
  it('opens a session, calls the tool and reads the image the server named', async () => {
    const fake = fakeMcpServer((method) => method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } : generated);
    const url = await listen(fake);
    const result = await new McpToolTransport({ url }).callTool('higgsfield_generate_image', { prompt: 'papel impresso', idempotency_key: 'digest-1' });

    expect(result).toEqual({ uri: 'higgsfield://asset-1', cost: 4, license: 'provider terms 2026', termsNote: 'Owner review required.' });
    expect(fake.received.map((entry) => entry.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(fake.received[2]?.params).toEqual({ name: 'higgsfield_generate_image', arguments: { prompt: 'papel impresso', idempotency_key: 'digest-1' } });
    // The session the server opened travels on every later request, and the
    // protocol version is declared on all of them.
    expect(fake.received.slice(1).every((entry) => entry.session === 'session-1')).toBe(true);
    expect(fake.received.every((entry) => entry.protocol === '2025-06-18')).toBe(true);
  });

  it('reads an answer the server streamed as server-sent events', async () => {
    const fake = fakeMcpServer((method) => method === 'initialize' ? { protocolVersion: '2025-06-18' } : generated, { sse: true });
    const url = await listen(fake);
    expect(await new McpToolTransport({ url }).callTool('higgsfield_generate_image', {})).toMatchObject({ uri: 'higgsfield://asset-1' });
  });

  it('turns inlined image bytes into the data URI a ready asset must carry', async () => {
    const fake = fakeMcpServer((method) => method === 'initialize' ? {} : { content: [{ type: 'image', mimeType: 'image/webp', data: 'AAAB' }] });
    const url = await listen(fake);
    expect(await new McpToolTransport({ url }).callTool('higgsfield_generate_image', {})).toEqual({ uri: 'data:image/webp;base64,AAAB' });
  });

  it('records a tool error as a failed asset instead of failing the gate', async () => {
    const fake = fakeMcpServer((method) => method === 'initialize' ? {} : { isError: true, content: [{ type: 'text', text: 'quota esgotada' }] });
    const url = await listen(fake);
    const provider = new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ url }) });
    const job = await provider.submit({ id: 'asset-job', digest: 'digest', prompt: 'papel impresso', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' });

    expect(job.status).toBe('failed');
    expect(job.provenance.status).toBe('failed');
    expect(job.provenance.termsNote).toContain('quota esgotada');
    expect(job.uri).toBeUndefined();
  });

  it('reports a server that refuses the request without repeating the endpoint', async () => {
    const fake = fakeMcpServer(() => ({}));
    const url = await listen(fake);
    fake.server.removeAllListeners('request');
    fake.server.on('request', (_request, response: ServerResponse) => { response.writeHead(401, { 'content-type': 'application/json' }).end('{}'); });
    const job = await new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ url }) })
      .submit({ id: 'asset-job', digest: 'digest', prompt: 'papel impresso', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' });

    expect(job.status).toBe('failed');
    expect(job.error).toContain('401');
    expect(job.error).not.toContain(url);
  });

  it('speaks the same protocol to a server it starts over stdio', async () => {
    const script = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        for (let cut = buffer.indexOf('\\n'); cut >= 0; cut = buffer.indexOf('\\n')) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          const result = message.method === 'initialize'
            ? { protocolVersion: '2025-06-18' }
            : { structuredContent: { url: 'higgsfield://stdio-asset', license: 'stdio terms' }, echo: message.params };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        }
      });
    `;
    const transport = new McpToolTransport({ command: process.execPath, args: ['-e', script], timeoutMs: 15_000 });
    expect(await transport.callTool('higgsfield_generate_image', { prompt: 'textura' })).toEqual({ uri: 'higgsfield://stdio-asset', license: 'stdio terms' });
  });

  it('fails the asset when the stdio server cannot be started', async () => {
    const transport = new McpToolTransport({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 15_000 });
    const job = await new HiggsfieldMcpProvider({ configured: true, transport })
      .submit({ id: 'asset-job', digest: 'digest', prompt: 'papel impresso', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' });
    expect(job.status).toBe('failed');
    expect(job.provenance.license).toBe('pending provider terms');
  });
});

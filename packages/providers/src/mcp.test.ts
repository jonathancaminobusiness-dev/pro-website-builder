import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HiggsfieldMcpProvider, McpToolTransport } from './index.js';

const request = { id: 'asset-job', digest: 'digest', prompt: 'papel impresso', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' };

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/**
 * A fake MCP server, spoken to over stdio exactly as a real one is. What is
 * asserted through it is the JSON-RPC the transport puts on the wire and the
 * job it builds from the answer, not the shape of a mock. `answers` is the body
 * of a function from the request message to the `tools/call` result.
 */
async function fakeMcpServer(answers: string, options: { record?: boolean } = {}): Promise<{ command: string; args: string[]; received: () => Promise<Array<Record<string, unknown>>> }> {
  directory ??= await mkdtemp(join(tmpdir(), 'pwb-mcp-'));
  const server = join(directory, `server-${Math.random().toString(36).slice(2, 8)}.mjs`);
  const log = join(directory, 'received.jsonl');
  await writeFile(server, `
    import { appendFileSync } from 'node:fs';
    const answer = (message) => { ${answers} };
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (let cut = buffer.indexOf('\\n'); cut >= 0; cut = buffer.indexOf('\\n')) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (${options.record ? 'true' : 'false'}) appendFileSync(${JSON.stringify(log)}, line + '\\n');
        if (message.id === undefined) continue;
        const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : answer(message);
        if (result === undefined) continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      }
    });
  `, 'utf8');
  const { readFile } = await import('node:fs/promises');
  return {
    command: process.execPath,
    args: [server],
    received: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const generated = "return { structuredContent: { url: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.', cost: 4 } };";

describe('mcp tool transport', () => {
  it('starts the server, opens a session and reads the image it named', async () => {
    const fake = await fakeMcpServer(generated, { record: true });
    const result = await new McpToolTransport({ command: fake.command, args: fake.args, timeoutMs: 15_000 })
      .callTool('higgsfield_generate_image', { prompt: 'papel impresso', idempotency_key: 'digest-1' });

    // The paid-API signal the tool volunteered is not carried into the record.
    expect(result).toEqual({ uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' });
    const received = await fake.received();
    expect(received.map((entry) => entry.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(received[2]?.params).toEqual({ name: 'higgsfield_generate_image', arguments: { prompt: 'papel impresso', idempotency_key: 'digest-1' } });
    expect((received[0]?.params as { protocolVersion?: string }).protocolVersion).toBe('2025-06-18');
  });

  it('reads the url a tool returned as plain text, without the punctuation that ends the sentence', async () => {
    const fake = await fakeMcpServer("return { content: [{ type: 'text', text: 'Pronto: https://cdn.higgsfield.ai/x.png.' }] };");
    expect(await new McpToolTransport({ ...fake, timeoutMs: 15_000 }).callTool('higgsfield_generate_image', {}))
      .toEqual({ uri: 'https://cdn.higgsfield.ai/x.png' });
  });

  it('reads a text block that is itself JSON as the record it is, not as prose to scan', async () => {
    // Scanning this would run the url into the quote that closes it.
    const fake = await fakeMcpServer(`return { content: [{ type: 'text', text: ${JSON.stringify('{"url":"https://cdn.higgsfield.ai/x.png","cost":0.02}')} }] };`);
    expect(await new McpToolTransport({ ...fake, timeoutMs: 15_000 }).callTool('higgsfield_generate_image', {}))
      .toEqual({ uri: 'https://cdn.higgsfield.ai/x.png' });
  });

  it('takes a JSON text block that names no image as an unrecognised shape', async () => {
    const fake = await fakeMcpServer(`return { content: [{ type: 'text', text: ${JSON.stringify('{"jobId":"j-1","state":"running"}')} }] };`);
    const job = await new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ ...fake, timeoutMs: 15_000 }) }).submit(request);
    expect(job.status).toBe('failed');
    expect(job.uri).toBeUndefined();
  });

  it('records an answer it recognises no image in as a failed asset naming the shape', async () => {
    const fake = await fakeMcpServer("return { content: [{ type: 'audio' }], structuredContent: { jobId: 'j-1', state: 'running' } };");
    const job = await new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ ...fake, timeoutMs: 15_000 }) }).submit(request);

    // An unanticipated shape is visible, not a job that merely looks unfinished.
    expect(job.status).toBe('failed');
    expect(job.provenance.termsNote).toContain('content: [audio]');
    expect(job.provenance.termsNote).toContain('structuredContent: {jobId, state}');
    // The keys are named; the values they held are not repeated.
    expect(job.provenance.termsNote).not.toContain('j-1');
  });

  it('records a tool error as a failed asset instead of failing the gate', async () => {
    const fake = await fakeMcpServer("return { isError: true, content: [{ type: 'text', text: 'quota esgotada' }] };");
    const job = await new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ ...fake, timeoutMs: 15_000 }) }).submit(request);

    expect(job.status).toBe('failed');
    expect(job.provenance.status).toBe('failed');
    expect(job.provenance.termsNote).toContain('quota esgotada');
    expect(job.uri).toBeUndefined();
  });

  it('drops a call the caller aborted instead of holding the server open', async () => {
    const fake = await fakeMcpServer('return undefined;');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const job = await new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ ...fake, timeoutMs: 15_000 }) })
      .submit(request, controller.signal);
    expect(job.status).toBe('failed');
  });

  it('fails the asset when the server cannot be started', async () => {
    const transport = new McpToolTransport({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 15_000 });
    const job = await new HiggsfieldMcpProvider({ configured: true, transport }).submit(request);
    expect(job.status).toBe('failed');
    expect(job.provenance.license).toBe('pending provider terms');
  });
});

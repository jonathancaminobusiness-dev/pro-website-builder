import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRunner, FakeModelProvider } from '@pwb/providers';
import { createModelProvider, createRasterProvider } from './provider.js';

const request = { id: 'asset-job', digest: 'digest', prompt: 'papel impresso em duas tintas', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' };

let running: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

// Ephemeral ports: several worktrees of this repo run their suites on one machine.
async function mcpEndpoint(): Promise<string> {
  const server = createServer((incoming, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { structuredContent: { url: 'higgsfield://asset-1', license: 'provider terms 2026' } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  running = server;
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe('model provider selection', () => {
  it('defaults to the fake provider and honors the claude-code choice', () => {
    expect(createModelProvider()).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('fake')).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('claude-code')).toBeInstanceOf(ClaudeRunner);
    expect(() => createModelProvider('openai')).toThrow(/fake or claude-code/i);
  });
});

describe('raster provider selection', () => {
  it('generates nothing until the owner names an MCP server', async () => {
    const job = await createRasterProvider({}).submit(request);
    expect(job.status).toBe('not_configured');
    expect(job.provenance.license).toBe('pending provider terms');
  });

  it('generates through the streamable HTTP endpoint the environment names', async () => {
    const url = await mcpEndpoint();
    const job = await createRasterProvider({ PWB_HIGGSFIELD_MCP_URL: url }).submit(request);
    expect(job.status).toBe('succeeded');
    expect(job.uri).toBe('higgsfield://asset-1');
    expect(job.provenance).toMatchObject({ license: 'provider terms 2026', prompt: request.prompt, identityVersionId: 'v0' });
  });

  it('reuses the higgsfield server the owner Claude Code already declares, and reads only its endpoint', async () => {
    const url = await mcpEndpoint();
    directory = await mkdtemp(join(tmpdir(), 'pwb-claude-home-'));
    await writeFile(join(directory, '.claude.json'), JSON.stringify({
      mcpServers: { higgsfield: { type: 'http', url }, other: { url: 'http://127.0.0.1:1/never' } },
      oauthAccount: { accessToken: 'must-never-be-read' },
    }), 'utf8');

    const job = await createRasterProvider({ PWB_HIGGSFIELD_MCP: 'claude-code', HOME: directory }).submit(request);
    expect(job.status).toBe('succeeded');
    expect(JSON.stringify(job)).not.toContain('must-never-be-read');
  });

  it('keeps the placeholder path when the owner declares no higgsfield server', async () => {
    directory = await mkdtemp(join(tmpdir(), 'pwb-claude-home-'));
    await writeFile(join(directory, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    expect((await createRasterProvider({ PWB_HIGGSFIELD_MCP: 'claude-code', HOME: directory }).submit(request)).status).toBe('not_configured');
  });

  it('starts the stdio server the environment names, with the arguments it lists', async () => {
    directory = await mkdtemp(join(tmpdir(), 'pwb-mcp-stdio-'));
    const server = join(directory, 'server.mjs');
    await writeFile(server, `
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
          const result = message.method === 'initialize' ? {} : { structuredContent: { url: process.argv[2] } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        }
      });
    `, 'utf8');

    // The second argument proves the list reaches the server: it answers with
    // the uri the environment named, not one of its own.
    const job = await createRasterProvider({ PWB_HIGGSFIELD_MCP_COMMAND: process.execPath, PWB_HIGGSFIELD_MCP_ARGS: `${server} higgsfield://from-args` }).submit(request);
    expect(job.status).toBe('succeeded');
    expect(job.uri).toBe('higgsfield://from-args');
  });
});

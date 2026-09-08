import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRunner, CodexRunner, FakeModelProvider } from '@pwb/providers';
import { createIdentityProvider, createModelProvider, createRasterProvider } from './provider.js';

const request = { id: 'asset-job', digest: 'digest', prompt: 'papel impresso em duas tintas', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' };

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('model provider selection', () => {
  it('defaults to the fake provider and honors the local provider choices', () => {
    expect(createModelProvider()).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('fake')).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('claude-code')).toBeInstanceOf(ClaudeRunner);
    expect(createModelProvider('codex')).toBeInstanceOf(CodexRunner);
    expect(createIdentityProvider('codex')).toBeInstanceOf(CodexRunner);
    expect(() => createModelProvider('openai')).toThrow(/fake, claude-code, or codex/i);
  });
});

describe('raster provider selection', () => {
  it('generates nothing until the owner names an MCP server', async () => {
    const job = await createRasterProvider({}).submit(request);
    expect(job.status).toBe('not_configured');
    expect(job.provenance.license).toBe('pending provider terms');
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
          const result = message.method === 'initialize' ? {} : { structuredContent: { url: process.argv[2], license: 'provider terms 2026' } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        }
      });
    `, 'utf8');

    // The second argument proves the list reaches the server: it answers with
    // the uri the environment named, not one of its own.
    const job = await createRasterProvider({ PWB_HIGGSFIELD_MCP_COMMAND: process.execPath, PWB_HIGGSFIELD_MCP_ARGS: `${server} higgsfield://from-args` }).submit(request);
    expect(job.status).toBe('succeeded');
    expect(job.uri).toBe('higgsfield://from-args');
    expect(job.provenance).toMatchObject({ license: 'provider terms 2026', prompt: request.prompt, identityVersionId: 'v0' });
  });

  it('reaches no endpoint the environment merely names a url for', async () => {
    // The product routes no credential, so there is no remote transport to
    // configure: a url alone leaves generation off rather than opening one.
    const job = await createRasterProvider({ PWB_HIGGSFIELD_MCP_URL: 'https://mcp.higgsfield.ai/mcp', PWB_HIGGSFIELD_MCP_TOKEN: 'owner-bearer-value' }).submit(request);
    expect(job.status).toBe('not_configured');
    expect(JSON.stringify(job)).not.toContain('owner-bearer-value');
  });
});

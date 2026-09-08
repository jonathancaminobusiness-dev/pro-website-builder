import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner, FakeModelProvider, HiggsfieldMcpProvider, McpToolTransport, type McpServerConfig, type ModelProvider, type RasterProvider } from '@pwb/providers';
import { FakeIdentityProvider } from '@pwb/stage-identity';

export type ModelProviderName = 'fake' | 'claude-code';

export function createModelProvider(name: string = 'fake'): ModelProvider {
  if (name === 'fake') return new FakeModelProvider();
  if (name === 'claude-code') return new ClaudeRunner();
  throw new Error(`Unknown model provider ${name}; use fake or claude-code.`);
}

/**
 * The identity stage asks its workers for role-specific artefacts, so its fake
 * is a different fixture from the one the phase 0 journey uses. The real
 * adapter is the same `ClaudeRunner`: the stage carries each role's closed
 * schema in the prompt it builds.
 */
export function createIdentityProvider(name: string = 'fake'): ModelProvider {
  if (name === 'fake') return new FakeIdentityProvider();
  if (name === 'claude-code') return new ClaudeRunner();
  throw new Error(`Unknown model provider ${name}; use fake or claude-code.`);
}

/**
 * Where the Higgsfield MCP server is, when the owner wants imagery generated.
 * Generation stays off unless one of these says otherwise, so a fresh checkout
 * and a test run never reach the network and keep the placeholder path:
 *
 * - `PWB_HIGGSFIELD_MCP_COMMAND` (with optional space-separated
 *   `PWB_HIGGSFIELD_MCP_ARGS`) speaks stdio to a local server;
 * - `PWB_HIGGSFIELD_MCP_URL` speaks streamable HTTP to a remote one;
 * - `PWB_HIGGSFIELD_MCP=claude-code` reuses the `higgsfield` server the owner's
 *   Claude Code already declares.
 *
 * Only the endpoint is ever read. The MCP server owns its own authentication,
 * and no credential is read, stored or logged anywhere on this path.
 */
export function createRasterProvider(env: NodeJS.ProcessEnv = process.env): RasterProvider {
  const config = rasterMcpConfig(env);
  return new HiggsfieldMcpProvider(config ? { configured: true, transport: new McpToolTransport(config) } : { configured: false });
}

function rasterMcpConfig(env: NodeJS.ProcessEnv): McpServerConfig | undefined {
  const command = env.PWB_HIGGSFIELD_MCP_COMMAND?.trim();
  if (command) return { command, args: (env.PWB_HIGGSFIELD_MCP_ARGS ?? '').split(' ').map((argument) => argument.trim()).filter(Boolean) };
  const url = env.PWB_HIGGSFIELD_MCP_URL?.trim();
  if (url) return { url };
  if (env.PWB_HIGGSFIELD_MCP?.trim() !== 'claude-code') return undefined;
  return claudeCodeHiggsfield(env.HOME ?? homedir());
}

function claudeCodeHiggsfield(home: string): McpServerConfig | undefined {
  let declared: unknown;
  try { declared = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')); } catch { return undefined; }
  const servers = (declared as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  const server = servers?.higgsfield as { url?: unknown; command?: unknown; args?: unknown } | undefined;
  if (!server) return undefined;
  if (typeof server.url === 'string' && server.url.trim()) return { url: server.url.trim() };
  if (typeof server.command === 'string' && server.command.trim()) {
    return { command: server.command.trim(), args: Array.isArray(server.args) ? server.args.filter((argument): argument is string => typeof argument === 'string') : [] };
  }
  return undefined;
}

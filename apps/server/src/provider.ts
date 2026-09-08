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
 * - `PWB_HIGGSFIELD_MCP_URL` speaks streamable HTTP to a remote one, with
 *   `PWB_HIGGSFIELD_MCP_TOKEN` as the bearer that endpoint asks for.
 *
 * The product never reads another tool's credential store, and the token it is
 * handed lives in this process only: it is sent as one header, and it is never
 * persisted, logged, echoed in an error or written to an event.
 */
export function createRasterProvider(env: NodeJS.ProcessEnv = process.env): RasterProvider {
  const config = rasterMcpConfig(env);
  return new HiggsfieldMcpProvider(config ? { configured: true, transport: new McpToolTransport(config) } : { configured: false });
}

function rasterMcpConfig(env: NodeJS.ProcessEnv): McpServerConfig | undefined {
  const command = env.PWB_HIGGSFIELD_MCP_COMMAND?.trim();
  if (command) return { command, args: (env.PWB_HIGGSFIELD_MCP_ARGS ?? '').split(' ').map((argument) => argument.trim()).filter(Boolean) };
  const url = env.PWB_HIGGSFIELD_MCP_URL?.trim();
  if (!url) return undefined;
  const token = env.PWB_HIGGSFIELD_MCP_TOKEN?.trim();
  return { url, ...(token ? { token } : {}) };
}

import { ClaudeRunner, CodexRunner, FakeModelProvider, HiggsfieldMcpProvider, McpToolTransport, type ClaudeRunnerOptions, type CodexJsonRunnerOptions, type ModelProvider, type RasterProvider } from '@pwb/providers';
import { FakeIdentityProvider } from '@pwb/stage-identity';

export type ModelProviderName = 'fake' | 'claude-code' | 'codex';

/** The one place a provider name is recognised, so no entry point can silently fall back to the fakes. */
export function modelProviderName(name: string = 'fake'): ModelProviderName {
  if (name === 'fake' || name === 'claude-code' || name === 'codex') return name;
  throw new Error(`Unknown model provider ${name}; use fake, claude-code, or codex.`);
}

export function createModelProvider(name: string = 'fake'): ModelProvider {
  const selected = modelProviderName(name);
  if (selected === 'claude-code') return new ClaudeRunner();
  if (selected === 'codex') return new CodexRunner();
  return new FakeModelProvider();
}

/**
 * The identity stage asks its workers for role-specific artefacts, so its fake
 * is a different fixture from the one the phase 0 journey uses. The real
 * adapters are `ClaudeRunner` and `CodexRunner`: the stage carries each role's
 * closed schema in the prompt it builds.
 */
export function createIdentityProvider(name: 'claude-code', options?: ClaudeRunnerOptions): ModelProvider;
export function createIdentityProvider(name: 'codex', options?: CodexJsonRunnerOptions): ModelProvider;
export function createIdentityProvider(name?: string, options?: ClaudeRunnerOptions | CodexJsonRunnerOptions): ModelProvider;
export function createIdentityProvider(name: string = 'fake', options: ClaudeRunnerOptions | CodexJsonRunnerOptions = {}): ModelProvider {
  const selected = modelProviderName(name);
  if (selected === 'claude-code') return new ClaudeRunner(options as ClaudeRunnerOptions);
  if (selected === 'codex') return new CodexRunner(options as CodexJsonRunnerOptions);
  return new FakeIdentityProvider();
}

/**
 * Where the Higgsfield MCP server is, when the owner wants imagery generated.
 * Generation stays off unless `PWB_HIGGSFIELD_MCP_COMMAND` names a server (with
 * optional space-separated `PWB_HIGGSFIELD_MCP_ARGS`), so a fresh checkout and
 * a test run never reach the network and keep the placeholder path.
 *
 * The command is the only shape on offer, because the product never collects,
 * stores or routes a credential: the server process it starts owns its own
 * authentication, and a hosted MCP is reached through an owner-run bridge that
 * performs that authentication itself.
 */
export function createRasterProvider(env: NodeJS.ProcessEnv = process.env): RasterProvider {
  const command = env.PWB_HIGGSFIELD_MCP_COMMAND?.trim();
  if (!command) return new HiggsfieldMcpProvider({ configured: false });
  const args = (env.PWB_HIGGSFIELD_MCP_ARGS ?? '').split(' ').map((argument) => argument.trim()).filter(Boolean);
  return new HiggsfieldMcpProvider({ configured: true, transport: new McpToolTransport({ command, args }) });
}

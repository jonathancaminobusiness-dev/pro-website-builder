import { ClaudeRunner, FakeModelProvider, type ModelProvider } from '@pwb/providers';
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

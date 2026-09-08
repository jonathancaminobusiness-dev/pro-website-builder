import { ClaudeRunner, FakeModelProvider, type ModelProvider } from '@pwb/providers';

export type ModelProviderName = 'fake' | 'claude-code';

export function createModelProvider(name: string = 'fake'): ModelProvider {
  if (name === 'fake') return new FakeModelProvider();
  if (name === 'claude-code') return new ClaudeRunner();
  throw new Error(`Unknown model provider ${name}; use fake or claude-code.`);
}

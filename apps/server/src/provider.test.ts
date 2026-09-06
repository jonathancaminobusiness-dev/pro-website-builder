import { describe, expect, it } from 'vitest';
import { ClaudeRunner, FakeModelProvider } from '@pwb/providers';
import { createModelProvider } from './provider.js';

describe('model provider selection', () => {
  it('defaults to the fake provider and honors the claude-code choice', () => {
    expect(createModelProvider()).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('fake')).toBeInstanceOf(FakeModelProvider);
    expect(createModelProvider('claude-code')).toBeInstanceOf(ClaudeRunner);
    expect(() => createModelProvider('openai')).toThrow(/fake or claude-code/i);
  });
});

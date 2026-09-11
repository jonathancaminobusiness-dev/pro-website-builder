import { describe, expect, it } from 'vitest';
import { CLAUDE_EFFORT, CLAUDE_MODEL, claudeModelFlags } from './claude-model.js';

describe('claude model pin', () => {
  it('pins every Claude worker to Opus 5 at high effort', () => {
    expect(CLAUDE_MODEL).toBe('claude-opus-5');
    expect(CLAUDE_EFFORT).toBe('high');
  });

  it('spells the flags the way the CLI accepts them', () => {
    expect(claudeModelFlags()).toEqual(['--model', 'claude-opus-5', '--effort', 'high']);
  });
});

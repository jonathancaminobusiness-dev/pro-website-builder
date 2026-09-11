import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_LEVELS, claudeInvocationFromEnvironment, claudeModelFlags, DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL, resolveClaudeInvocation,
} from './claude-model.js';

describe('Claude model and effort configuration', () => {
  it('pins Opus 5 at high effort when nothing is configured', () => {
    expect(claudeInvocationFromEnvironment({})).toEqual({ model: 'claude-opus-5', effort: 'high' });
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
    expect(DEFAULT_CLAUDE_EFFORT).toBe('high');
  });

  it('lets the install override either variable on its own', () => {
    expect(claudeInvocationFromEnvironment({ PWB_CLAUDE_MODEL: ' claude-sonnet-5 ' })).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
    expect(claudeInvocationFromEnvironment({ PWB_CLAUDE_EFFORT: 'max' })).toEqual({ model: 'claude-opus-5', effort: 'max' });
  });

  it('accepts every effort level the claude binary documents', () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of CLAUDE_EFFORT_LEVELS) {
      expect(claudeInvocationFromEnvironment({ PWB_CLAUDE_EFFORT: level }).effort).toBe(level);
    }
  });

  it('refuses a malformed value rather than falling back to the machine default', () => {
    expect(() => claudeInvocationFromEnvironment({ PWB_CLAUDE_EFFORT: 'highest' })).toThrow(/PWB_CLAUDE_EFFORT must be one of low, medium, high, xhigh, max/);
    expect(() => claudeInvocationFromEnvironment({ PWB_CLAUDE_MODEL: '   ' })).toThrow(/PWB_CLAUDE_MODEL must name a single model/);
    expect(() => claudeInvocationFromEnvironment({ PWB_CLAUDE_MODEL: 'claude-opus-5 --dangerously' })).toThrow(/PWB_CLAUDE_MODEL must name a single model/);
  });

  it('lets an explicit option win over the environment', () => {
    expect(resolveClaudeInvocation({ effort: 'low' }, { PWB_CLAUDE_EFFORT: 'max', PWB_CLAUDE_MODEL: 'claude-sonnet-5' }))
      .toEqual({ model: 'claude-sonnet-5', effort: 'low' });
  });

  it('spells the flags the way the claude binary does', () => {
    expect(claudeModelFlags({ model: 'claude-opus-5', effort: 'high' })).toEqual(['--model', 'claude-opus-5', '--effort', 'high']);
  });
});

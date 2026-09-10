import { describe, expect, it } from 'vitest';
import { identityDeadlinesFromEnvironment } from './identity-deadlines.js';

describe('identity critic deadlines', () => {
  it('reads a role default and lets a named critic override it', () => {
    expect(identityDeadlinesFromEnvironment({
      PWB_IDENTITY_CRITIC_DEADLINE_MS: '240000',
      PWB_IDENTITY_CRITIC_SYSTEM_A11Y_CRITIC_DEADLINE_MS: '600000',
    })).toEqual({
      critic: 240000,
      criticById: { 'system-a11y-critic': 600000 },
    });
  });

  it('rejects a configured deadline that is not a positive integer', () => {
    expect(() => identityDeadlinesFromEnvironment({ PWB_IDENTITY_CRITIC_SYSTEM_A11Y_CRITIC_DEADLINE_MS: '0' })).toThrow(/positive integer/i);
  });
});

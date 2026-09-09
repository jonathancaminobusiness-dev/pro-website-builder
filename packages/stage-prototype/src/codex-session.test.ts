import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CodexSession } from './codex-session.js';

const answerSchema = z.object({ answer: z.string() });

describe('Codex prototype session', () => {
  it('retries one schema correction through the shared structured-session boundary', async () => {
    const prompts: string[] = [];
    let attempts = 0;
    const session = new CodexSession({
      runner: {
        run: async ({ prompt }) => {
          prompts.push(prompt);
          attempts += 1;
          return attempts === 1 ? { answer: 42 } : { answer: 'ok' };
        },
      },
    });

    await expect(session.ask({
      sessionId: 'codex-session-test', prompt: 'fixture', schema: { type: 'object' },
      parse: (value) => answerSchema.parse(value), deadlineMs: 1000,
    })).resolves.toEqual({ answer: 'ok' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('did not match the supplied schema');
  });
});

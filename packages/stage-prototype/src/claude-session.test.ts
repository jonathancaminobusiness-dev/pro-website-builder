import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ClaudeSession, type ClaudeExecutor } from './claude-session.js';

/**
 * A schema whose real rule lives in `superRefine`, exactly like the section
 * window and the token-reference rules the composers break: JSON Schema can
 * describe the shape, so a model that answered the wrong window still answers
 * something the schema accepts and only the refinement rejects it.
 */
const windowSchema = z.object({ sectionId: z.string(), nodeIds: z.array(z.string()) }).superRefine((value, ctx) => {
  if (value.nodeIds.join(',') !== 'home-hero-root,home-hero-title') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeIds'], message: 'Section home-hero must return exactly home-hero-root, home-hero-title in that order.' });
  }
});

interface Invocation { args: string[]; timeoutMs: number }

function recorder(answers: unknown[]): { calls: Invocation[]; execute: ClaudeExecutor } {
  const calls: Invocation[] = [];
  return {
    calls,
    execute: async (_executable, args, run) => {
      calls.push({ args, timeoutMs: run.timeoutMs });
      const answer = answers[calls.length - 1];
      if (answer instanceof Error) throw answer;
      return JSON.stringify({ structured_output: answer });
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const ask = { sessionId: 'compose-home-hero', schema: { type: 'object' }, deadlineMs: 60_000 };

describe('Claude structured session', () => {
  it('corrects the model with the violations it actually committed, not with a generic schema complaint', async () => {
    const { calls, execute } = recorder([
      { sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-proof-title'] },
      { sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] },
    ]);
    const session = new ClaudeSession({ execute });

    await expect(session.ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) }))
      .resolves.toEqual({ sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] });

    expect(calls).toHaveLength(2);
    const correction = flag(calls[1]!.args, '-p')!;
    expect(correction).toContain('Compose home-hero.');
    expect(correction).toContain('nodeIds: Section home-hero must return exactly home-hero-root, home-hero-title in that order.');
  });

  it('says an unreadable answer was unreadable rather than naming a violation it cannot see', async () => {
    const calls: string[] = [];
    const session = new ClaudeSession({
      execute: async (_executable, args) => { calls.push(flag(args, '-p')!); return calls.length === 1 ? 'not json at all' : JSON.stringify({ sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] }); },
    });

    await expect(session.ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) })).resolves.toBeDefined();
    expect(calls[1]).toContain('could not be read as the requested JSON');
  });

});

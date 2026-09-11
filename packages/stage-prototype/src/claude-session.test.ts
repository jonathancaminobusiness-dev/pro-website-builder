import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ClaudeSession, ClaudeSessionError, CRITIC_DENIED_TOOLS, WORKER_DENIED_TOOLS, type ClaudeExecutor } from './claude-session.js';

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

const ask = { schema: { type: 'object' }, deadlineMs: 60_000 };

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

  it('opens a fresh session id on every attempt and never persists one', async () => {
    const { calls, execute } = recorder([
      { sectionId: 'home-hero', nodeIds: [] },
      { sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] },
    ]);

    await new ClaudeSession({ execute }).ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) });

    const ids = calls.map((call) => flag(call.args, '--session-id')!);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const call of calls) expect(call.args).toContain('--no-session-persistence');
  });

  it('denies the worker every tool and carries no credential flag', async () => {
    const { calls, execute } = recorder([{ sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] }]);
    await new ClaudeSession({ execute }).ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) });

    expect(flag(calls[0]!.args, '--disallowed-tools')).toBe(WORKER_DENIED_TOOLS);
    expect(WORKER_DENIED_TOOLS.split(' ')).toContain('Read');
    expect(CRITIC_DENIED_TOOLS.split(' ')).not.toContain('Read');
    expect(calls[0]!.args.join(' ')).not.toMatch(/--api-key|--token|ANTHROPIC_API_KEY/i);
  });

  it('keeps the kill distinct from the failure, so a timeout is not reported as an unknown error', async () => {
    const killed = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    const session = new ClaudeSession({ execute: async () => { throw killed; } });

    await expect(session.ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) }))
      .rejects.toMatchObject({ name: 'ClaudeSessionError', errorCode: 'SIGTERM' });

    const timedOut = Object.assign(new Error('timeout'), { killed: true });
    await expect(new ClaudeSession({ execute: async () => { throw timedOut; } })
      .ask({ ...ask, prompt: 'Compose home-hero.', parse: (value) => windowSchema.parse(value) }))
      .rejects.toMatchObject({ errorCode: 'TIMEOUT' });
  });

  it('bounds the call by whichever is shorter, its own timeout or the task deadline', async () => {
    const { calls, execute } = recorder([{ sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] }, { sectionId: 'home-hero', nodeIds: ['home-hero-root', 'home-hero-title'] }]);
    const session = new ClaudeSession({ execute, timeoutMs: 30_000 });

    await session.ask({ ...ask, prompt: 'a', parse: (value) => windowSchema.parse(value), deadlineMs: 90_000 });
    expect(calls[0]!.timeoutMs).toBe(30_000);
    await session.ask({ ...ask, prompt: 'b', parse: (value) => windowSchema.parse(value), deadlineMs: 5_000 });
    expect(calls[1]!.timeoutMs).toBe(5_000);
  });

  it('lets an abort through untouched instead of dressing it as a session error', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = new ClaudeSession({ execute: async () => { throw new DOMException('aborted', 'AbortError'); } });

    await expect(session.ask({ ...ask, prompt: randomUUID(), parse: (value) => windowSchema.parse(value), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a process failure with the code the process gave it', async () => {
    const session = new ClaudeSession({ execute: async () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } });
    await expect(session.ask({ ...ask, prompt: 'x', parse: (value) => windowSchema.parse(value) }))
      .rejects.toBeInstanceOf(ClaudeSessionError);
  });
});

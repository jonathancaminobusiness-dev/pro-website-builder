import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask } from '@pwb/domain';
import { CODEX_ALLOWLIST_DIRECTORY, CODEX_MODEL, CODEX_REASONING_EFFORT, CODEX_WORKSPACE_PREFIX, CodexJsonRunner, CodexRunner } from './index.js';

/** The checkout this suite runs in; no Codex session may be given a directory inside it. */
async function repositoryRoot(): Promise<string> {
  let directory = resolve(process.cwd());
  for (;;) {
    try {
      await stat(join(directory, '.git'));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error('The provider suite must run inside a checkout.');
      directory = parent;
    }
  }
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

const task: AgentTask = {
  id: 'task-codex', attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude',
  baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'codex', deadlineMs: 5_000,
  allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture',
};

const result = {
  taskId: task.id, status: 'succeeded' as const, summary: 'Codex fixture completed.',
  proposal: {
    operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['ok'] }],
    baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'fixture', confidence: 1,
    stage: 'identity' as const, role: 'director' as const,
  },
};

describe('Codex provider', () => {
  it('pins the requested model and normal service and parses the final JSONL message', async () => {
    const calls: { executable: string; args: string[]; cwd: string }[] = [];
    const provider = new CodexRunner({
      execute: async (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd });
        return {
          stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'fixture' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`,
          stderr: '',
        };
      },
    });

    await expect(provider.propose(task)).resolves.toMatchObject({ taskId: task.id, status: 'succeeded', proposal: { idempotencyKey: expect.any(String) } });
    const args = calls[0]!.args;
    expect(calls[0]!.executable).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '-m', CODEX_MODEL, '-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT}`, '-c', 'service_tier="standard"', '-c', 'features.fast_mode=false', '--sandbox', 'read-only', '--ephemeral', '--json']));
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="standard"', '-c', 'features.fast_mode=false']));
    expect(args).not.toContain('features.fast_mode=true');
    expect(args).not.toContain('--output-schema');
    expect(args).not.toContain('--api-key');
  });

  it('describes the AgentResult envelope when Codex is not given a provider schema', async () => {
    let prompt = '';
    const provider = new CodexRunner({
      execute: async (_executable, args) => {
        prompt = args.at(-1)!;
        return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`, stderr: '' };
      },
    });

    await provider.propose({ ...task, role: 'curator' });
    expect(prompt).toContain('Return exactly one AgentResult JSON object');
    expect(prompt).toContain('taskId');
    expect(prompt).toContain('artifact');
  });

  it('passes closed schemas to direct Codex responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-codex-schema-'));
    try {
      const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
      let args: string[] = [];
      const runner = new CodexJsonRunner({
        execute: async (_executable, receivedArgs) => {
          args = receivedArgs;
          const schemaPath = receivedArgs[receivedArgs.indexOf('--output-schema') + 1]!;
          expect(schemaPath).not.toBe(JSON.stringify(schema));
          await expect(readFile(schemaPath, 'utf8').then((text) => JSON.parse(text))).resolves.toEqual(schema);
          return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) } })}\n`, stderr: '' };
        },
      });

      await expect(runner.run({ prompt: 'fixture', schema, deadlineMs: 1000 })).resolves.toEqual({ answer: 'ok' });
      expect(args).toEqual(expect.arrayContaining(['--output-schema', expect.any(String)]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('opens the schema it wrote when the Codex CLI is spawned for real', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-codex-real-spawn-'));
    const script = join(directory, 'codex-fixture.mjs');
    const executable = join(directory, 'codex-fixture');
    await writeFile(script, [
      "import { readFile } from 'node:fs/promises';",
      "const schemaIndex = process.argv.indexOf('--output-schema');",
      "if (schemaIndex < 0) process.exit(2);",
      "await readFile(process.argv[schemaIndex + 1], 'utf8');",
      "console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({answer: 'ok'})}}));",
    ].join('\n'), 'utf8');
    await writeFile(executable, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`, 'utf8');
    await chmod(executable, 0o755);
    try {
      const runner = new CodexJsonRunner({ executable, timeoutMs: 1_000 });
      await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1_000 })).resolves.toEqual({ answer: 'ok' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports an actionable error when the Codex CLI is unavailable', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_UNAVAILABLE' });
  });

  it('reports an actionable error when Codex authentication is missing', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex login required'), { code: 'CODEX_AUTH', stderr: 'Please run codex login.' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/not authenticated/i) });
  });

  it('surfaces a sign-in failure returned on stderr', async () => {
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout: '', stderr: 'Codex requires ChatGPT sign-in.' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

  it('surfaces a sign-in failure after non-answer JSONL output', async () => {
    const runner = new CodexJsonRunner({
      execute: async () => ({
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'fixture' })}\n${JSON.stringify({ type: 'turn.started' })}\n`,
        stderr: 'Codex requires ChatGPT sign-in.',
      }),
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/codex login/i) });
  });

  it('surfaces a sign-in failure after a failed JSONL turn', async () => {
    const runner = new CodexJsonRunner({
      execute: async () => ({
        stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: 'request failed' } })}\n`,
        stderr: 'Codex requires ChatGPT sign-in.',
      }),
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/codex login/i) });
  });

  it('keeps a valid terminal answer despite incidental auth-like stderr', async () => {
    const runner = new CodexJsonRunner({
      execute: async () => ({
        stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) } })}\n`,
        stderr: 'warning: authentication cache refreshed',
      }),
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).resolves.toEqual({ answer: 'ok' });
  });

  it('reports a non-auth process failure without echoing stderr', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex failed'), { code: 'EIO', stderr: 'authorization=sk-secret-value' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED', message: expect.not.stringContaining('sk-secret-value') });
  });

  it('reports an ordinary non-zero exit as a process failure rather than a timeout', async () => {
    const runner = new CodexJsonRunner({
      execute: async () => { throw Object.assign(new Error('Command failed'), { code: 1, signal: null, killed: false, stderr: 'error: unexpected argument' }); },
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED' });
  });

  it('rejects a valid-looking answer when Codex exits non-zero without a terminal event', async () => {
    const stdout = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'partial' }) } })}\n`;
    const runner = new CodexJsonRunner({
      execute: async () => { throw Object.assign(new Error('Command failed'), { code: 1, signal: null, killed: false, stdout, stderr: '' }); },
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED' });
  });

  it('does not blame a missing CLI for a model the account cannot use', async () => {
    const runner = new CodexJsonRunner({
      execute: async () => ({ stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: "model 'gpt-5.6-sol' not found" } })}\n`, stderr: '' }),
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED' });
  });

  it('does not treat a missing model as an unavailable CLI when the process reports it', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error("model 'gpt-5.6-sol' not found"), { code: 'EIO', stderr: "model 'gpt-5.6-sol' not found" }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED' });
  });

  it('maps a process timeout and preserves an abort signal', async () => {
    let timeoutMs = 0;
    const timeout = new CodexJsonRunner({ timeoutMs: 10_000, execute: async (_executable, _args, options) => { timeoutMs = options.timeoutMs; throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } });
    await expect(timeout.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_TIMEOUT' });
    expect(timeoutMs).toBe(1000);

    const aborted = Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
    const runner = new CodexJsonRunner({ execute: async () => { throw aborted; } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toBe(aborted);
  });

  it('turns an authentication failure event into a clear login error', async () => {
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: 'Please run codex login.' } })}\n`, stderr: '' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/codex login/i) });
  });

  it('classifies authentication JSONL captured on stdout after a non-zero exit', async () => {
    const stdout = `${JSON.stringify({ type: 'turn.failed', error: { message: 'Please run codex login.' } })}\n`;
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex exited'), { code: 'EIO', stdout, stderr: '' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

  it('preserves an authentication failure when a non-zero exit contains incidental stdout', async () => {
    let calls = 0;
    const runner = new CodexJsonRunner({
      execute: async () => {
        calls += 1;
        throw Object.assign(new Error('Codex exited'), { code: 'EIO', stdout: 'not-json\n', stderr: 'Codex requires ChatGPT sign-in.' });
      },
    });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
    expect(calls).toBe(1);
  });

  it('does not retry a schema correction over an authentication failure with stdout', async () => {
    let calls = 0;
    const provider = new CodexRunner({
      execute: async () => {
        calls += 1;
        throw Object.assign(new Error('Codex exited'), { code: 'EIO', stdout: 'not-json\n', stderr: 'Codex requires ChatGPT sign-in.' });
      },
    });
    await expect(provider.propose(task)).resolves.toMatchObject({ status: 'failed', errorCode: 'CODEX_AUTH_REQUIRED' });
    expect(calls).toBe(1);
  });

  it('preserves authentication failure through schema validation with malformed JSON output', async () => {
    let calls = 0;
    const provider = new CodexRunner({
      execute: async () => {
        calls += 1;
        return { stdout: '{}\n', stderr: 'Codex requires ChatGPT sign-in.' };
      },
    });
    await expect(provider.propose(task)).resolves.toMatchObject({ status: 'failed', errorCode: 'CODEX_AUTH_REQUIRED' });
    expect(calls).toBe(1);
  });

  it('keeps schema correction for malformed output with incidental authentication warnings', async () => {
    let calls = 0;
    const provider = new CodexRunner({
      execute: async () => {
        calls += 1;
        return { stdout: '{}\n', stderr: 'warning: authentication cache refreshed' };
      },
    });
    await expect(provider.propose(task)).resolves.toMatchObject({ status: 'needs_review', errorCode: 'SCHEMA_INVALID' });
    expect(calls).toBe(2);
  });

  it('does not accept an earlier answer when a non-zero exit reports a terminal failure', async () => {
    const stdout = [
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'earlier' }) } },
      { type: 'turn.failed', error: {} },
    ].map((event) => JSON.stringify(event)).join('\n');
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex exited'), { code: 'EIO', stdout, stderr: '' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED' });
  });

  it('retries a schema correction when malformed JSONL was captured on stdout after a non-zero exit', async () => {
    let calls = 0;
    const malformed = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not-json' } })}\n`;
    const provider = new CodexRunner({
      execute: async (_executable, args) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('Codex exited'), { code: 'EIO', stdout: malformed, stderr: '' });
        return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`, stderr: '' };
      },
    });
    await expect(provider.propose(task)).resolves.toMatchObject({ taskId: task.id, status: 'succeeded' });
    expect(calls).toBe(2);
  });

  it('rejects a malformed final message instead of using an earlier answer', async () => {
    const stdout = [
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'earlier' }) } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'not-json' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    // Exercise the parser through the runner contract without invoking a process.
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout, stderr: '' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });

  it('runs each session in a dedicated workspace that is never the repository checkout', async () => {
    const repository = await repositoryRoot();
    const directories: string[] = [];
    const provider = new CodexRunner({
      execute: async (_executable, args, options) => {
        directories.push(args[args.indexOf('-C') + 1]!);
        expect(options.cwd).toBe(args[args.indexOf('-C') + 1]);
        return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`, stderr: '' };
      },
    });

    await expect(provider.propose(task)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(provider.propose(task)).resolves.toMatchObject({ status: 'succeeded' });
    expect(directories).toHaveLength(2);
    for (const directory of directories) {
      expect(directory).not.toBe(repository);
      expect(inside(repository, directory)).toBe(false);
      expect(directory.startsWith(join(resolve(tmpdir()), CODEX_WORKSPACE_PREFIX))).toBe(true);
      // The session directory is torn down with the session it belonged to.
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(directories[0]).not.toBe(directories[1]);
  });

  it('gives a session nothing but its allowlist and the schema it must answer with', async () => {
    const repository = await repositoryRoot();
    const source = await mkdtemp(join(tmpdir(), 'pwb-codex-allowlist-'));
    await writeFile(join(source, 'brand.json'), '{"brand":"fixture"}', 'utf8');
    try {
      let entries: string[] = [];
      let copied = '';
      let prompt = '';
      const runner = new CodexJsonRunner({
        execute: async (_executable, args) => {
          const workspace = args[args.indexOf('-C') + 1]!;
          prompt = args[args.length - 1]!;
          entries = (await readdir(workspace)).sort();
          copied = await readFile(join(workspace, CODEX_ALLOWLIST_DIRECTORY, '0', 'brand.json'), 'utf8');
          return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) } })}\n`, stderr: '' };
        },
      });

      await expect(runner.run({
        prompt: `read ${join(source, 'brand.json')} first`, schema: { type: 'object' }, deadlineMs: 1_000,
        allowlist: [join(source, 'brand.json')],
      })).resolves.toEqual({ answer: 'ok' });
      expect(entries).toEqual([CODEX_ALLOWLIST_DIRECTORY, 'schema.json']);
      expect(copied).toBe('{"brand":"fixture"}');
      // The prompt names the copy inside the workspace, never the original outside it.
      expect(prompt).not.toContain(join(source, 'brand.json'));
      expect(prompt).toMatch(/read .*allowlist\/0\/brand\.json first/);
      expect(inside(repository, prompt.slice(prompt.indexOf('read ') + 5, prompt.indexOf(' first')))).toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('keeps allowlisted entries from colliding with each other or with the schema', async () => {
    const source = await mkdtemp(join(tmpdir(), 'pwb-codex-collision-'));
    await mkdir(join(source, 'a'), { recursive: true });
    await mkdir(join(source, 'b'), { recursive: true });
    await writeFile(join(source, 'a', 'brand.json'), '"a"', 'utf8');
    await writeFile(join(source, 'b', 'brand.json'), '"b"', 'utf8');
    await writeFile(join(source, 'schema.json'), '"not the output schema"', 'utf8');
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    const allowlist = [join(source, 'a', 'brand.json'), join(source, 'b', 'brand.json'), join(source, 'schema.json')];
    try {
      const seen: string[] = [];
      let outputSchema: unknown;
      const runner = new CodexJsonRunner({
        execute: async (_executable, args) => {
          const prompt = args[args.length - 1]!;
          outputSchema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1]!, 'utf8'));
          for (const line of prompt.split('\n')) seen.push(await readFile(line, 'utf8'));
          return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) } })}\n`, stderr: '' };
        },
      });

      await expect(runner.run({ prompt: allowlist.join('\n'), schema, deadlineMs: 1_000, allowlist })).resolves.toEqual({ answer: 'ok' });
      expect(seen).toEqual(['"a"', '"b"', '"not the output schema"']);
      expect(outputSchema).toEqual(schema);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('fails with an actionable error when an allowlisted path cannot be read', async () => {
    let invoked = false;
    const runner = new CodexJsonRunner({ execute: async () => { invoked = true; return { stdout: '', stderr: '' }; } });

    await expect(runner.run({
      prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1_000,
      allowlist: [join(tmpdir(), 'pwb-codex-missing-allowlist-entry.json')],
    })).rejects.toMatchObject({ code: 'CODEX_ALLOWLIST_UNREADABLE' });
    expect(invoked).toBe(false);
  });

  it('leaves no schema directory behind inside the repository', async () => {
    const repository = await repositoryRoot();
    let schemaPath = '';
    const runner = new CodexJsonRunner({
      execute: async (_executable, args) => {
        schemaPath = args[args.indexOf('--output-schema') + 1]!;
        return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) } })}\n`, stderr: '' };
      },
    });

    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1_000 })).resolves.toEqual({ answer: 'ok' });
    expect(inside(repository, schemaPath)).toBe(false);
    await expect(stat(schemaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(repository)).some((entry) => entry.startsWith('.pwb-codex-'))).toBe(false);
  });

  it('closes Codex stdin so the CLI can finish when invoked through execFile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-codex-stdin-'));
    const script = join(directory, 'wait-for-stdin.mjs');
    const executable = join(directory, 'codex-fixture');
    await writeFile(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({ok: true})}})));",
    ].join('\n'), 'utf8');
    await writeFile(executable, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`, 'utf8');
    await chmod(executable, 0o755);
    try {
      await expect(new CodexJsonRunner({ executable, timeoutMs: 1000 }).run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).resolves.toEqual({ ok: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

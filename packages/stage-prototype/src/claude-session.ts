import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { claudeModelFlags, correctionPrompt } from '@pwb/providers';

const execFileAsync = promisify(execFile);

/** The Claude worker boundary denies the filesystem and network; a Claude critic keeps Read for its screenshots. */
export const WORKER_DENIED_TOOLS = 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit';
export const CRITIC_DENIED_TOOLS = 'Bash Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit';

export type ClaudeExecutor = (executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string>;

export interface ClaudeSessionOptions {
  executable?: string;
  timeoutMs?: number;
  maxTurns?: number;
  deniedTools?: string;
  /** Injected by tests; production spawns the owner's local Claude Code binary with no shell. */
  execute?: ClaudeExecutor;
}

export class ClaudeSessionError extends Error {
  constructor(public readonly errorCode: string, message: string) {
    super(message);
    this.name = 'ClaudeSessionError';
  }
}

export interface ClaudeAsk<T> {
  prompt: string;
  schema: unknown;
  parse: (value: unknown) => T;
  deadlineMs: number;
  /** Paths this ask names and the worker must be able to open, such as a critic's own screenshots. */
  allowlist?: readonly string[];
  signal?: AbortSignal;
}

export interface StructuredSession {
  ask<T>(input: ClaudeAsk<T>): Promise<T>;
}

/**
 * One structured turn against the owner's local Claude Code binary: a fresh session, a closed JSON
 * schema, a deadline, an abort signal and a denied tool list. It never reads, stores, prints, forwards
 * or asks for a credential, and no paid API is involved.
 */
export class ClaudeSession implements StructuredSession {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly deniedTools: string;
  private readonly execute: ClaudeExecutor;

  constructor(options: ClaudeSessionOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.maxTurns = options.maxTurns ?? 4;
    this.deniedTools = options.deniedTools ?? WORKER_DENIED_TOOLS;
    this.execute = options.execute ?? (async (executable, args, run) => {
      const { stdout } = await execFileAsync(executable, args, {
        shell: false, timeout: run.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(run.signal ? { signal: run.signal } : {}),
      });
      return stdout;
    });
  }

  async ask<T>(input: ClaudeAsk<T>): Promise<T> {
    let prompt = input.prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const stdout = await this.execute(this.executable, [
          '-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(input.schema),
          // A fresh id per attempt, never derived from the task: a correction must reach a session that
          // has never seen the answer it is correcting, and the CLI takes a UUID and nothing else.
          '--session-id', randomUUID(), '--no-session-persistence', '--max-turns', String(this.maxTurns),
          '--disallowed-tools', this.deniedTools,
          ...claudeModelFlags(),
        ], { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: Math.min(this.timeoutMs, input.deadlineMs) });
        const raw: unknown = JSON.parse(stdout);
        const structured = raw && typeof raw === 'object' && 'structured_output' in raw ? (raw as { structured_output: unknown }).structured_output : raw;
        return input.parse(structured);
      } catch (error) {
        const details = error as { name?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
        if (details.name === 'AbortError' || details.code === 'ABORT_ERR') throw error;
        const schemaProblem = error instanceof SyntaxError || error instanceof ZodError;
        if (schemaProblem && attempt === 0) { prompt = correctionPrompt(input.prompt, error); continue; }
        if (schemaProblem) throw new ClaudeSessionError('SCHEMA_INVALID', 'Claude returned an answer that does not match the supplied schema.');
        // A process the kernel killed is a different fact from one that exited with an error, and the
        // caller escalates them differently; collapsing both into the exit code loses the deadline.
        const killedBy = details.signal === undefined || details.signal === null ? '' : String(details.signal);
        if (killedBy || details.killed === true) throw new ClaudeSessionError(killedBy || 'TIMEOUT', `The Claude Code process was terminated by ${killedBy || 'a timeout'}.`);
        throw new ClaudeSessionError(String(details.code ?? 'PROCESS_FAILED'), `The Claude Code process failed with ${String(details.code ?? 'an unknown error')}.`);
      }
    }
    throw new ClaudeSessionError('RUNNER_EXHAUSTED', 'The Claude Code session did not produce an answer.');
  }
}

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ClaudeRunnerOptions } from './model.js';

const execFileAsync = promisify(execFile);

/**
 * A worker that answers one closed question with JSON that matches a schema.
 *
 * This is the same safety boundary as `ClaudeRunner`: no shell, a fresh session
 * that is never persisted, tools denied so a headless worker cannot touch the
 * filesystem, a deadline and an abort signal. It never reads, stores, prints,
 * forwards or asks for a credential, and it never writes to the document.
 */
export interface JsonRunRequest {
  /** Everything the worker may read. The caller is responsible for keeping it immutable. */
  prompt: string;
  /** JSON Schema handed to the binary so the answer is closed by construction. */
  schema: unknown;
  deadlineMs: number;
}

export interface JsonModelRunner {
  run(request: JsonRunRequest, signal?: AbortSignal): Promise<unknown>;
}

function isSchemaFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ZodError') return true;
  const code = (error as { code?: unknown }).code;
  return code === 'SCHEMA_INVALID';
}

export async function runValidatedJson<T>(runner: JsonModelRunner, request: JsonRunRequest, parse: (raw: unknown) => T, signal?: AbortSignal): Promise<T> {
  let prompt = request.prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: unknown;
    try {
      raw = await runner.run({ ...request, prompt }, signal);
    } catch (error) {
      if (!isSchemaFailure(error) || attempt > 0) throw error;
      prompt = `${request.prompt}\nCorrect the previous schema violation and return only JSON matching the supplied schema.`;
      continue;
    }
    try {
      return parse(raw);
    } catch (error) {
      if (!isSchemaFailure(error) || attempt > 0) throw error;
      prompt = `${request.prompt}\nCorrect the previous schema violation and return only JSON matching the supplied schema.`;
    }
  }
  throw new Error('Structured JSON validation exhausted its correction attempt.');
}

export class JsonRunnerError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = 'JsonRunnerError'; }
}

const DENIED_TOOLS = 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit';

export class ClaudeJsonRunner implements JsonModelRunner {
  private readonly options: Required<Omit<ClaudeRunnerOptions, 'timeoutMs'>>;

  constructor(options: Omit<ClaudeRunnerOptions, 'timeoutMs'> = {}) {
    this.options = { executable: 'claude', maxTurns: 4, ...options };
  }

  async run(request: JsonRunRequest, signal?: AbortSignal): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.options.executable, [
        '-p', request.prompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(request.schema),
        '--session-id', randomUUID(),
        '--no-session-persistence',
        '--max-turns', String(this.options.maxTurns),
        '--disallowed-tools', DENIED_TOOLS,
      ], { shell: false, timeout: request.deadlineMs, signal, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const raw: unknown = JSON.parse(stdout);
      return raw && typeof raw === 'object' && 'structured_output' in raw ? (raw as { structured_output: unknown }).structured_output : raw;
    } catch (error) {
      const details = error as { code?: unknown; signal?: unknown; killed?: unknown; name?: unknown };
      if (details.code === 'ABORT_ERR' || details.name === 'AbortError') throw error;
      if (error instanceof SyntaxError) throw new JsonRunnerError('The worker did not return JSON.', 'SCHEMA_INVALID');
      const killedBy = details.signal === undefined || details.signal === null ? '' : String(details.signal);
      if (killedBy || details.killed === true) throw new JsonRunnerError(`The Claude Code process was terminated by ${killedBy || 'a timeout'}.`, killedBy || 'TIMEOUT');
      throw new JsonRunnerError(`The Claude Code process failed with ${details.code === undefined ? 'an unknown error' : String(details.code)}.`, details.code === undefined ? 'PROCESS_FAILED' : String(details.code));
    }
  }
}

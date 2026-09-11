import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { CLAUDE_RUNNER_TIMEOUT_MS, execFileExecutor } from './claude-runner.js';
import type { ClaudeRunnerOptions } from './model.js';

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
  /** JSON Schema the provider may hand to its binary; every provider validates the answer on return. */
  schema: unknown;
  /**
   * Paths this one request may read, named in the prompt. A sandboxed provider
   * copies them into the session's workspace and points the prompt at the
   * copies; a provider whose worker reads the originals ignores it. Empty by
   * default, because a worker is answered from its prompt alone.
   */
  allowlist?: readonly string[];
  strictSchema?: boolean;
  deadlineMs: number;
}

export interface JsonModelRunner {
  run(request: JsonRunRequest, signal?: AbortSignal): Promise<unknown>;
  runValidated?<T>(request: JsonRunRequest, parse: (raw: unknown) => T, signal?: AbortSignal): Promise<T>;
}

function isSchemaFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ZodError') return true;
  const code = (error as { code?: unknown }).code;
  return code === 'SCHEMA_INVALID';
}

/** How many violations a correction prompt carries; a model that broke fifty rules is not helped by all fifty. */
const CORRECTION_ISSUE_LIMIT = 12;

/**
 * The one correction a structured worker gets, carrying the violations that
 * actually happened. Most of what fails here are `superRefine` rules the JSON
 * Schema cannot express - a window that must hold exactly these node ids, a prop
 * that must be a token reference - so a model told only "your answer did not
 * match the schema" is corrected for the wrong reason and then fails fatally.
 * An answer that was not JSON at all has no issues to name and says so instead
 * of inventing one.
 */
export function correctionPrompt(prompt: string, error: unknown): string {
  const issues = error instanceof ZodError
    ? error.issues.slice(0, CORRECTION_ISSUE_LIMIT).map((issue) => `- ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    : [];
  const violation = issues.length > 0
    ? `These are the violations your previous answer carried; every one of them has to be gone from the next one:\n${issues.join('\n')}${error instanceof ZodError && error.issues.length > issues.length ? `\n- (and ${error.issues.length - issues.length} more of the same kind)` : ''}`
    : `Your previous answer could not be read as the requested JSON: ${error instanceof Error ? error.message : String(error)}`;
  return `${prompt}\n\nYour previous answer did not match the supplied schema. ${violation}\n\nReturn only JSON matching the schema.`;
}

export async function runValidatedJson<T>(runner: JsonModelRunner, request: JsonRunRequest, parse: (raw: unknown) => T, signal?: AbortSignal): Promise<T> {
  let prompt = request.prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (runner.runValidated) return await runner.runValidated({ ...request, prompt }, parse, signal);
      return parse(await runner.run({ ...request, prompt }, signal));
    } catch (error) {
      if (!isSchemaFailure(error) || attempt > 0) throw error;
      prompt = correctionPrompt(request.prompt, error);
      continue;
    }
  }
  throw new Error('Structured JSON validation exhausted its correction attempt.');
}

export class JsonRunnerError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = 'JsonRunnerError'; }
}

/** The headless JSON worker touches nothing: no filesystem, no network, no sub-agent. */
export const JSON_RUNNER_DENIED_TOOLS = 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit';

/** The production spawn: no shell, the request's own deadline, and nothing of the parent environment beyond it. */
const executeClaudeJson: ClaudeExecutor = async (executable, args, options) => await execFileAsync(executable, args, {
  shell: false, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}),
});

const executeClaudeJson = execFileExecutor(8 * 1024 * 1024);

export class ClaudeJsonRunner implements JsonModelRunner {
  private readonly options: Required<ClaudeRunnerOptions>;

  /** `execute` is injected by tests; production spawns the owner's local Claude Code binary with no shell. */
  constructor(options: ClaudeRunnerOptions = {}) {
    this.options = { executable: 'claude', timeoutMs: CLAUDE_RUNNER_TIMEOUT_MS, maxTurns: 4, execute: executeClaudeJson, ...options };
  }

  async run(request: JsonRunRequest, signal?: AbortSignal): Promise<unknown> {
    try {
      // One invocation never outlives its own cap, whatever budget the caller's
      // remaining deadline still allows — the rule `CodexJsonRunner` already
      // applies, and the one the README states per claude invocation.
      const { stdout } = await this.options.execute(this.options.executable, [
        '-p', request.prompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(request.schema),
        '--session-id', randomUUID(),
        '--no-session-persistence',
        '--max-turns', String(this.options.maxTurns),
        '--disallowed-tools', JSON_RUNNER_DENIED_TOOLS,
      ], { timeoutMs: Math.min(this.options.timeoutMs, request.deadlineMs), ...(signal ? { signal } : {}) });
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

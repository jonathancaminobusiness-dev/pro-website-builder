import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ZodError } from 'zod';
import { agentResultSchema, documentPathSchemas, documentRules, idempotencyKey, stageResultJsonSchemas, visualPropKeys, type AgentResult, type AgentTask } from '@pwb/domain';
import type { JsonModelRunner, JsonRunRequest } from './json-runner.js';
import type { ModelProvider } from './model.js';

const CODEX_AUTH_FAILURE = /\b(?:auth|authentication|authenticated|login|credential|unauthori[sz]ed|not logged)\b|chatgpt sign[- ]?in/i;

export const CODEX_MODEL = 'gpt-5.6-sol';
export const CODEX_REASONING_EFFORT = 'high';
export const CODEX_RUNNER_TIMEOUT_MS = 7 * 60_000;

export interface CodexExecutorOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  cwd: string;
}

export type CodexExecutor = (executable: string, args: string[], options: CodexExecutorOptions) => Promise<{ stdout: string; stderr: string }>;

export interface CodexJsonRunnerOptions {
  executable?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Injected by tests; production executes the local Codex CLI. */
  execute?: CodexExecutor;
}

export class CodexCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CodexCliError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonText(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function payloadFrom(value: unknown): unknown {
  if (!record(value)) return typeof value === 'string' ? parseJsonText(value) : undefined;
  if ('structured_output' in value) return value.structured_output;
  if ('structuredOutput' in value) return value.structuredOutput;
  if (value.type === 'output_text' && typeof value.text === 'string') return parseJsonText(value.text);
  if (typeof value.text === 'string') return parseJsonText(value.text);
  if (typeof value.output_text === 'string') return parseJsonText(value.output_text);
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      const payload = payloadFrom(item);
      if (payload !== undefined) return payload;
    }
  }
  if ('output' in value) return payloadFrom(value.output);
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (record(value) && typeof value.message === 'string') return value.message;
  return undefined;
}

/** Parses Codex's JSONL event stream and returns the final structured agent message. */
export function parseCodexOutput(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let finalAgentMessage: unknown;
  let sawAgentMessage = false;
  let responseCandidate: unknown;
  let failureMessage: string | undefined;
  for (const line of lines) {
    const event = parseJsonText(line);
    if (event === undefined) continue;
    if (!record(event)) continue;
    if (event.type === 'item.completed') {
      const item = event.item;
      if (record(item) && (item.type === 'agent_message' || item.type === 'message')) {
        sawAgentMessage = true;
        finalAgentMessage = payloadFrom(item);
      }
      continue;
    }
    if (event.type === 'response.output_text.done' || event.type === 'response.completed') {
      const payload = payloadFrom(event);
      if (payload !== undefined) responseCandidate = payload;
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      failureMessage = errorMessage(event.error) ?? errorMessage(event) ?? `Codex emitted ${String(event.type)}.`;
    }
  }
  if (failureMessage !== undefined) throw classifyProcessError({ code: 'CODEX_PROCESS_FAILED', stderr: failureMessage });
  if (sawAgentMessage) {
    if (finalAgentMessage !== undefined) return finalAgentMessage;
    throw new CodexCliError('SCHEMA_INVALID', 'Codex did not return a final JSON message matching the requested schema.');
  }
  if (responseCandidate !== undefined) return responseCandidate;
  const direct = lines.length === 1 ? parseJsonText(lines[0]!) : undefined;
  if (direct !== undefined) {
    const payload = payloadFrom(direct);
    return payload === undefined ? direct : payload;
  }
  throw new CodexCliError('SCHEMA_INVALID', 'Codex did not return a final JSON message matching the requested schema.');
}

function classifyProcessError(error: unknown): CodexCliError {
  const details = error as { code?: unknown; stderr?: unknown; message?: unknown; signal?: unknown; killed?: unknown };
  const code = details.code === undefined ? '' : String(details.code);
  const stderr = details.stderr === undefined ? '' : String(details.stderr);
  const message = stderr || (details.message === undefined ? '' : String(details.message));
  const signal = details.signal === undefined || details.signal === null ? '' : String(details.signal);
  if (code === 'ENOENT' || /command not found|not recognized as an internal or external command/i.test(message)) {
    return new CodexCliError('CODEX_UNAVAILABLE', 'Codex CLI was not found. Install Codex CLI and run `codex login` before selecting PWB_MODEL_PROVIDER=codex.');
  }
  if (code === 'CODEX_AUTH' || CODEX_AUTH_FAILURE.test(message)) {
    return new CodexCliError('CODEX_AUTH_REQUIRED', 'Codex CLI is not authenticated. Run `codex login` with your ChatGPT account before selecting PWB_MODEL_PROVIDER=codex.');
  }
  if (code === 'ETIMEDOUT' || details.killed === true || signal) {
    return new CodexCliError('CODEX_TIMEOUT', 'Codex CLI did not finish before the stage deadline.');
  }
  return new CodexCliError('CODEX_PROCESS_FAILED', `Codex CLI failed (${code || 'unknown process error'}).`);
}

async function executeCodex(executable: string, args: string[], options: CodexExecutorOptions): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      cwd: options.cwd,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        // Preserve the captured streams for classifyProcessError. In
        // particular, Codex reports schema and login failures through its
        // JSONL stdout while the child process still exits non-zero.
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    // Codex reads stdin as an optional second prompt. This runner supplies the
    // prompt as an argument, so close the unused stream immediately; otherwise
    // the CLI waits for EOF until the stage deadline expires.
    child.stdin?.end();
  });
}

async function withSchemaFile<T>(cwd: string, schema: unknown, operation: (schemaPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(cwd, '.pwb-codex-schema-'));
  try {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) throw new Error('Codex output schema could not be serialized.');
    const schemaPath = join(directory, 'schema.json');
    await writeFile(schemaPath, serialized, 'utf8');
    return await operation(schemaPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class CodexJsonRunner implements JsonModelRunner {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly execute: CodexExecutor;

  constructor(options: CodexJsonRunnerOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.timeoutMs = options.timeoutMs ?? CODEX_RUNNER_TIMEOUT_MS;
    this.execute = options.execute ?? executeCodex;
  }

  async run(request: JsonRunRequest, signal?: AbortSignal): Promise<unknown> {
    try {
      const execute = (schemaPath?: string): Promise<{ stdout: string; stderr: string }> => this.execute(this.executable, [
        'exec', '-m', CODEX_MODEL, '-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT}`,
        '-c', 'service_tier="standard"', '-c', 'features.fast_mode=false',
        '--json', ...(schemaPath ? ['--output-schema', schemaPath] : []),
        '--sandbox', 'read-only', '--ephemeral', '-C', this.cwd, request.prompt,
      ], { cwd: this.cwd, timeoutMs: Math.min(this.timeoutMs, request.deadlineMs), ...(signal ? { signal } : {}) });
      const result = request.strictSchema === false ? await execute() : await withSchemaFile(this.cwd, request.schema, execute);
      if (!result.stdout.trim() && CODEX_AUTH_FAILURE.test(result.stderr)) {
        throw classifyProcessError({ code: 'CODEX_AUTH', stderr: result.stderr });
      }
      try {
        return parseCodexOutput(result.stdout);
      } catch (error) {
        if (error instanceof CodexCliError && CODEX_AUTH_FAILURE.test(result.stderr)) {
          throw classifyProcessError({ code: 'CODEX_AUTH', stderr: result.stderr });
        }
        throw error;
      }
    } catch (error) {
      const details = error as { code?: unknown; name?: unknown };
      if (details.code === 'ABORT_ERR' || details.name === 'AbortError') throw error;
      if (error instanceof CodexCliError) throw error;
      const stderr = (error as { stderr?: unknown }).stderr;
      // A non-zero Codex exit may leave incidental or malformed JSON on stdout,
      // but an auth diagnostic on stderr is still the actionable outcome.
      if (typeof stderr === 'string' && CODEX_AUTH_FAILURE.test(stderr)) {
        throw classifyProcessError({ code: 'CODEX_AUTH', stderr });
      }
      const processError = classifyProcessError(error);
      if (processError.code !== 'CODEX_PROCESS_FAILED') throw processError;
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && stdout.trim()) return parseCodexOutput(stdout);
      throw processError;
    }
  }
}

function codexPrompt(task: AgentTask, correction: boolean): string {
  return [
    task.brief,
    'Return exactly one AgentResult JSON object with the required taskId, status and summary fields. Set taskId to the task id above and status to succeeded when you have an answer. For read-only roles, put the typed answer in artifact and omit proposal; for patch roles, put the patch in proposal and any typed companion answer in artifact.',
    `Answer as the ${task.role} of the ${task.stage} stage for taskId ${task.id}.`,
    `A proposal must set baseVersionId to ${task.baseVersionId} and may only touch these paths: ${task.allowedPaths.join(', ')}.`,
    `A page node may only declare these props: ${[...visualPropKeys].join(', ')} and text.`,
    `The gate also enforces rules the JSON Schema cannot state, and rejects a proposal that breaks any of them: ${Object.values(documentRules).join(' ')}`,
    `Every operation value must match the JSON Schema of the document subtree it writes: ${JSON.stringify(Object.fromEntries(task.allowedPaths.filter((path) => path in documentPathSchemas).map((path) => [path, documentPathSchemas[path]])))}`,
    `This is the immutable slice of the current document you may read; the identity contract is read-only: ${JSON.stringify(task.documentSlice)}`,
    correction ? 'Correct the previous schema violation and return only JSON matching the supplied schema.' : '',
  ].filter(Boolean).join('\n');
}

export class CodexRunner implements ModelProvider {
  private readonly runner: CodexJsonRunner;

  constructor(options: CodexJsonRunnerOptions = {}) {
    this.runner = new CodexJsonRunner(options);
  }

  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    let correction = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.runner.run({ prompt: codexPrompt(task, correction), schema: stageResultJsonSchemas[task.stage], strictSchema: false, deadlineMs: task.deadlineMs }, signal);
        const result = agentResultSchema.parse(raw);
        return result.proposal ? { ...result, proposal: { ...result.proposal, idempotencyKey: idempotencyKey(task) } } : result;
      } catch (error) {
        const details = error as { code?: unknown; name?: unknown };
        if (details.code === 'ABORT_ERR' || details.name === 'AbortError') throw error;
        const schemaProblem = error instanceof ZodError || (error instanceof CodexCliError && error.code === 'SCHEMA_INVALID');
        if (schemaProblem && !correction) { correction = true; continue; }
        if (schemaProblem) return { taskId: task.id, status: 'needs_review', summary: 'Codex returned an invalid structured proposal.', errorCode: 'SCHEMA_INVALID' };
        const providerError = error instanceof CodexCliError ? error : classifyProcessError(error);
        return { taskId: task.id, status: 'failed', summary: providerError.message, errorCode: providerError.code };
      }
    }
    return { taskId: task.id, status: 'failed', summary: 'Codex process did not complete.', errorCode: 'RUNNER_EXHAUSTED' };
  }
}

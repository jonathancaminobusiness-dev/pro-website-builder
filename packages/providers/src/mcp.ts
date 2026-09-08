import { spawn } from 'node:child_process';
import type { HiggsfieldMcpTransport } from './higgsfield.js';

/**
 * Where an MCP server is and how to speak to it. Exactly one transport applies:
 * a streamable HTTP endpoint, or a command spoken to over stdio.
 *
 * `token` is the bearer the hosted endpoint asks for, supplied by the owner for
 * the length of one process. It is sent as the `Authorization` header and
 * nowhere else: it is never persisted, never written to an event, and never
 * repeated in an error, which is also why a refused request is reported by
 * status alone — the endpoint itself may carry a credential in its query. A
 * stdio server owns its own authentication and is given none.
 */
export type McpServerConfig =
  | { url: string; token?: string; timeoutMs?: number }
  | { command: string; args?: string[]; timeoutMs?: number };

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'pro-website-builder', version: '0.1.0' };
const DEFAULT_TIMEOUT_MS = 120_000;

interface JsonRpcAnswer { id?: number | string; result?: unknown; error?: { code: number; message: string } }
type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface McpContentItem { type?: string; text?: string; uri?: string; resource?: { uri?: string } }
export interface McpToolResult { content?: McpContentItem[]; structuredContent?: Record<string, unknown>; isError?: boolean }

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The image a text block names. A tool without `structuredContent` usually
 * serialises its answer as JSON, so a parseable block is read as the record it
 * is and never scanned: scanning it would run the URL into the quote that
 * closes it. A prose block is scanned instead, stopping before the punctuation
 * that ends the sentence rather than at the next space.
 */
function urlInText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return textOf(record.uri) ?? textOf(record.url);
  }
  const found = /https?:\/\/[^\s"'<>`]+/.exec(trimmed)?.[0];
  return textOf(found?.replace(/[.,;:!?)\]}]+$/, ''));
}

/**
 * Where the image is, in the three forms a tool answers with: a structured
 * field, a linked resource, or a URL in the text it returned.
 */
function uriOf(result: McpToolResult): string | undefined {
  const structured = result.structuredContent ?? {};
  const declared = textOf(structured.uri) ?? textOf(structured.url);
  if (declared) return declared;
  for (const item of result.content ?? []) {
    const linked = textOf(item.uri) ?? textOf(item.resource?.uri) ?? urlInText(item.text);
    if (linked) return linked;
  }
  return undefined;
}

/**
 * The keys an answer carried, and nothing it carried. An unrecognised shape has
 * to be visible to the owner, and the shape is what makes it recognisable next
 * time; the values are not repeated because a signed URL or a token could be
 * among them.
 */
function shapeOf(result: McpToolResult): string {
  const keys = Object.keys(result).sort().join(', ') || 'no keys';
  const items = (result.content ?? []).map((item) => item.type ?? 'untyped').join(', ');
  const structured = Object.keys(result.structuredContent ?? {}).sort().join(', ');
  return [keys, items ? `content: [${items}]` : '', structured ? `structuredContent: {${structured}}` : ''].filter(Boolean).join('; ');
}

export function readMcpToolResult(result: McpToolResult): { uri: string; cost?: number; license?: string; termsNote?: string } {
  if (result.isError) {
    const detail = (result.content ?? []).map((item) => item.text ?? '').join(' ').trim();
    throw new Error(`The MCP tool answered with an error: ${detail || 'no detail given'}`);
  }
  const uri = uriOf(result);
  if (!uri) throw new Error(`The MCP tool answered with no image this client recognises (${shapeOf(result)}).`);
  const structured = result.structuredContent ?? {};
  const license = textOf(structured.license);
  const termsNote = textOf(structured.termsNote);
  return {
    uri,
    ...(typeof structured.cost === 'number' ? { cost: structured.cost } : {}),
    ...(license ? { license } : {}),
    ...(termsNote ? { termsNote } : {}),
  };
}

function answerIn(body: string, contentType: string, id: number): JsonRpcAnswer | undefined {
  if (!contentType.includes('text/event-stream')) return body.trim() ? JSON.parse(body) as JsonRpcAnswer : undefined;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const answer = JSON.parse(line.slice(5).trim()) as JsonRpcAnswer;
    if (answer.id === id) return answer;
  }
  return undefined;
}

function resultOf(answer: JsonRpcAnswer | undefined, method: string): unknown {
  if (!answer) throw new Error(`The MCP server returned no answer for ${method}.`);
  if (answer.error) throw new Error(`The MCP server refused ${method}: ${answer.error.message}`);
  return answer.result;
}

/**
 * A minimal MCP client: it opens a session, calls one tool and closes again.
 * Every call is its own session, which costs one handshake and keeps no process
 * or socket alive between images; the raster lane runs one job at a time, so
 * there is nothing to pool. The caller's signal ends the call wherever it is —
 * the fetch is aborted, the child process is killed — because a raster task
 * carries a deadline the scheduler enforces.
 */
export class McpToolTransport implements HiggsfieldMcpTransport {
  constructor(private readonly config: McpServerConfig) {}

  async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<{ uri: string; cost?: number; license?: string; termsNote?: string }> {
    const invoke = async (call: Call): Promise<McpToolResult> => await call('tools/call', { name, arguments: arguments_ }) as McpToolResult;
    const result = 'url' in this.config ? await this.overHttp(invoke, signal) : await this.overStdio(invoke, signal);
    return readMcpToolResult(result ?? {});
  }

  private async overHttp<T>(work: (call: Call) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const config = this.config as { url: string; token?: string; timeoutMs?: number };
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let session: string | undefined;
    let counter = 0;
    const post = async (message: Record<string, unknown>, id?: number): Promise<JsonRpcAnswer | undefined> => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(message),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      session = response.headers.get('mcp-session-id') ?? session;
      if (!response.ok) throw new Error(`The MCP server answered ${response.status} ${response.statusText}.`);
      const body = await response.text();
      return id === undefined ? undefined : answerIn(body, response.headers.get('content-type') ?? '', id);
    };
    const call: Call = async (method, params) => {
      counter += 1;
      return resultOf(await post({ jsonrpc: '2.0', id: counter, method, ...(params ? { params } : {}) }, counter), method);
    };
    await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return work(call);
  }

  private async overStdio<T>(work: (call: Call) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const config = this.config as { command: string; args?: string[]; timeoutMs?: number };
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(config.command, config.args ?? [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    const waiting = new Map<number, { settle: (answer: JsonRpcAnswer) => void; fail: (error: Error) => void }>();
    const failAll = (error: Error): void => { for (const waiter of [...waiting.values()]) waiter.fail(error); waiting.clear(); };
    const stop = (): void => { failAll(new Error('The MCP call was cancelled.')); child.kill(); };
    signal?.addEventListener('abort', stop, { once: true });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        let answer: JsonRpcAnswer;
        try { answer = JSON.parse(line) as JsonRpcAnswer; } catch { continue; }
        if (typeof answer.id !== 'number') continue;
        const waiter = waiting.get(answer.id);
        if (!waiter) continue;
        waiting.delete(answer.id);
        waiter.settle(answer);
      }
    });
    child.on('error', (error: Error) => failAll(error));
    child.stdin.on('error', (error: Error) => failAll(error));
    child.on('exit', (code, killed) => failAll(new Error(`The MCP server exited with ${killed ?? code ?? 'no status'} before answering.`)));

    let counter = 0;
    const send = (message: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    const call: Call = async (method, params) => {
      counter += 1;
      const id = counter;
      const answer = await new Promise<JsonRpcAnswer>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('The MCP call was cancelled.')); return; }
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`The MCP server did not answer ${method} in time.`)); }, timeoutMs);
        waiting.set(id, { settle: (value) => { clearTimeout(timer); resolve(value); }, fail: (error) => { clearTimeout(timer); reject(error); } });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
      return resultOf(answer, method);
    };
    try {
      await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return await work(call);
    } finally {
      signal?.removeEventListener('abort', stop);
      child.stdin.end();
      child.kill();
    }
  }
}

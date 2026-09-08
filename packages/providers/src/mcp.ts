import { spawn } from 'node:child_process';
import type { HiggsfieldMcpTransport } from './higgsfield.js';

/**
 * The MCP server to speak to, as a command this process starts and talks to
 * over stdio. There is no remote endpoint here on purpose: the product never
 * collects, stores or routes a credential, so a hosted MCP is reached through
 * an owner-run bridge that performs its own authentication and is spoken to
 * like any other local server.
 */
export interface McpServerConfig { command: string; args?: string[]; timeoutMs?: number }

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

export function readMcpToolResult(result: McpToolResult): { uri: string; license?: string; termsNote?: string } {
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
    ...(license ? { license } : {}),
    ...(termsNote ? { termsNote } : {}),
  };
}

function resultOf(answer: JsonRpcAnswer | undefined, method: string): unknown {
  if (!answer) throw new Error(`The MCP server returned no answer for ${method}.`);
  if (answer.error) throw new Error(`The MCP server refused ${method}: ${answer.error.message}`);
  return answer.result;
}

/**
 * A minimal MCP client: it starts the server, opens a session, calls one tool
 * and closes again. Every call is its own session, which costs one handshake
 * and keeps no process alive between images; the raster lane runs one job at a
 * time, so there is nothing to pool. The caller's signal ends the call wherever
 * it is — the child process is killed — because a raster task carries a
 * deadline the scheduler enforces. The server's stderr is discarded rather than
 * recorded, because an MCP server may print its own authentication state and
 * this process never keeps one.
 */
export class McpToolTransport implements HiggsfieldMcpTransport {
  constructor(private readonly config: McpServerConfig) {}

  async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<{ uri: string; license?: string; termsNote?: string }> {
    const invoke = async (call: Call): Promise<McpToolResult> => await call('tools/call', { name, arguments: arguments_ }) as McpToolResult;
    return readMcpToolResult(await this.overStdio(invoke, signal) ?? {});
  }

  private async overStdio<T>(work: (call: Call) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(this.config.command, this.config.args ?? [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
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

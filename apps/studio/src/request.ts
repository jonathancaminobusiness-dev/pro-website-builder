/**
 * What the API answered, as something the caller can act on. A definitive
 * refusal carries the HTTP status the server sent; a request that never reached
 * a server carries none. The screen needs to tell those apart: a 404 means the
 * run is gone and the pointer to it should go too, while a server that is not
 * listening yet means wait for it.
 */
export class RequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * Why a request never reached the API. A browser reports both causes as the
 * same opaque failure — WebKit even words a refused connection as "due to
 * access control checks", which reads like an origin problem when nothing is
 * listening at all — so the two are told apart by asking the API's `/health`
 * route rather than by guessing from the thrown error. `unknown` is the honest
 * third answer: the server is up and welcomes this origin, so the one failed
 * request said nothing about either.
 */
export type ConnectionFailure = 'unreachable' | 'origin-refused' | 'unknown';

/**
 * `no-cors` is the discriminator: a browser completes such a request (opaquely)
 * whenever something answered, and rejects it only when nothing did. So a
 * normal probe that succeeds means the origin is welcome; a normal probe that
 * fails while the opaque one succeeds means something answered and refused this
 * origin — unless the server simply finished starting between the two probes,
 * which produces the same pair, so the normal probe is asked once more before
 * an origin is accused. Outside a browser `mode` is ignored, which collapses
 * the middle case — the one only a browser can produce — so tests supply their
 * own probe for it.
 */
export async function classifyConnectionFailure(url: string, probe: typeof fetch = fetch): Promise<ConnectionFailure> {
  const health = healthUrl(url);
  if (await answers(health, probe)) return 'unknown';
  try { await probe(health, { cache: 'no-store', mode: 'no-cors' }); } catch { return 'unreachable'; }
  return await answers(health, probe) ? 'unknown' : 'origin-refused';
}

async function answers(health: string, probe: typeof fetch): Promise<boolean> {
  try { await probe(health, { cache: 'no-store' }); return true; } catch { return false; }
}

function healthUrl(url: string): string {
  try { return new URL('/health', url).toString(); } catch { return url; }
}

export interface ServerWaitOptions {
  /** How many times the API is asked before the wait gives up. */
  attempts?: number;
  firstDelayMs?: number;
  maxDelayMs?: number;
  probe?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The server builds its workspace dependencies before it listens, so a captain
 * who follows the README and opens the Studio in the other terminal arrives
 * during a startup window that is measured in tens of seconds. Waiting it out
 * is the whole point: the API is asked again on a widening backoff until it
 * answers, and only a cause that waiting cannot fix — an origin this server
 * refuses — or the ceiling ends the wait.
 */
export async function waitForServer(apiOrigin: string, options: ServerWaitOptions = {}): Promise<'ready' | ConnectionFailure> {
  const attempts = options.attempts ?? 18;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const probe = options.probe ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let delay = options.firstDelayMs ?? 250;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const measured = await classifyConnectionFailure(apiOrigin, probe);
    if (measured === 'unknown') return 'ready';
    if (measured === 'origin-refused') return measured;
    if (attempt + 1 === attempts) return measured;
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelayMs);
  }
  return 'unreachable';
}

/** What the screen says while the startup window is being waited out. */
export function waitingForServerMessage(apiOrigin: string): string {
  return `Aguardando o servidor em ${originOf(apiOrigin)}…`;
}

/**
 * The remedy, in the captain's language, for the cause that was measured. Each
 * message names the origin it is talking about, because the two failures look
 * identical in the console and only differ in what the captain has to do next.
 */
export function connectionFailureMessage(reason: ConnectionFailure, url: string, pageOrigin = globalThis.location?.origin ?? ''): string {
  const api = originOf(url);
  if (reason === 'unreachable') return `Nenhum servidor respondeu em ${api}. Inicie a API com "corepack pnpm --filter @pwb/server dev" e espere a linha "listening" antes de recarregar esta página.`;
  if (reason === 'origin-refused') return `O servidor em ${api} respondeu, mas recusou a origem ${pageOrigin}. Ele aceita uma única origem do Studio: abra o Studio em http://127.0.0.1:5173 ou inicie o servidor com PWB_STUDIO_ORIGIN=${pageOrigin}.`;
  return 'O servidor local não respondeu.';
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new RequestError('O servidor local não respondeu.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new RequestError(payload.error ?? 'Não foi possível concluir a ação.', response.status);
  }
  return await response.json() as T;
}

/**
 * A 404 is the server saying the run is not there. Every other failure — a
 * refusal it could not explain, or no answer at all — says nothing about
 * whether the run exists, so the pointer to it is worth keeping.
 */
export function isMissing(cause: unknown): boolean {
  return cause instanceof RequestError && cause.status === 404;
}

/**
 * No answer at all, as opposed to an answer that refused: the only failure a
 * screen can do something about by waiting, and the only one whose cause is
 * worth measuring.
 */
export function isConnectionFailure(cause: unknown): boolean {
  return cause instanceof RequestError && cause.status === undefined;
}

export function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Erro desconhecido.';
}

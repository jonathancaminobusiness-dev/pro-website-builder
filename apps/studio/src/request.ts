/**
 * What the API answered, as something the caller can act on. A definitive
 * refusal carries the HTTP status the server sent; a request that never reached
 * a server carries none. The screen needs to tell those apart: a 404 means the
 * run is gone and the pointer to it should go too, while a server that is not
 * listening yet means try again.
 */
export class RequestError extends Error {
  constructor(message: string, readonly status?: number, readonly reason?: ConnectionFailure) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * Why a request never reached the API. A browser reports both causes as the
 * same opaque failure — WebKit even words a refused connection as "due to
 * access control checks", which reads like an origin problem when nothing is
 * listening at all — so the two are told apart by asking the API's `/health`
 * route twice rather than by guessing from the thrown error.
 */
export type ConnectionFailure = 'unreachable' | 'origin-refused' | 'unknown';

/**
 * `no-cors` is the discriminator: a browser completes such a request (opaquely)
 * whenever something answered, and rejects it only when nothing did. So a
 * normal probe that succeeds means the origin is welcome and this one request
 * failed for its own reasons; a normal probe that fails while the opaque one
 * succeeds means the server is up and refused this origin. Outside a browser
 * `mode` is ignored, which collapses the middle case — the one only a browser
 * can produce — so tests supply their own probe for it.
 */
export async function classifyConnectionFailure(url: string, probe: typeof fetch = fetch): Promise<ConnectionFailure> {
  const health = new URL('/health', url).toString();
  try { await probe(health, { cache: 'no-store' }); return 'unknown'; } catch { /* ask again without the origin check */ }
  try { await probe(health, { cache: 'no-store', mode: 'no-cors' }); return 'origin-refused'; } catch { return 'unreachable'; }
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
    const reason = await classifyConnectionFailure(url);
    throw new RequestError(connectionFailureMessage(reason, url), undefined, reason);
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

export function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Erro desconhecido.';
}

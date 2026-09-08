/**
 * What the API answered, as something the caller can act on. A definitive
 * refusal carries the HTTP status the server sent; a request that never reached
 * a server carries none. The screen needs to tell those apart: a 404 means the
 * run is gone and the pointer to it should go too, while a server that is not
 * listening yet means try again.
 */
export class RequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RequestError';
  }
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

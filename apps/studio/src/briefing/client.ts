/**
 * The one place the Studio speaks to the conversation endpoints. It imports the
 * wire shapes from `./contract.js`; when the server slice publishes the shared
 * package, that import is the only line that changes.
 */
import { requestJson, RequestError } from '../request.js';
import {
  conversationConfirmPath,
  conversationPath,
  parseConversationSnapshot,
  type ConversationConfirmRequest,
  type ConversationSendRequest,
  type ConversationSnapshot,
} from './contract.js';

export type JsonRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface ConversationClient {
  /**
   * Reopens the conversation at the point the execution persisted. A server
   * that has no conversation for this run answers 404 and this resolves to
   * `null` — the old briefing flow keeps working, and nothing silently falls
   * back to a default conversation.
   */
  resume(runId: string): Promise<ConversationSnapshot | null>;
  send(runId: string, request: ConversationSendRequest): Promise<ConversationSnapshot>;
  confirm(runId: string, request: ConversationConfirmRequest): Promise<ConversationSnapshot>;
}

export function createConversationClient(apiOrigin: string, request: JsonRequest = requestJson): ConversationClient {
  const call = async (path: string, init?: RequestInit): Promise<ConversationSnapshot> =>
    parseConversationSnapshot(await request<unknown>(`${apiOrigin}${path}`, init));
  return {
    async resume(runId) {
      try {
        return await call(conversationPath(runId));
      } catch (cause) {
        if (cause instanceof RequestError && cause.status === 404) return null;
        throw cause;
      }
    },
    send: (runId, body) => call(conversationPath(runId), { method: 'POST', body: JSON.stringify(body) }),
    confirm: (runId, body) => call(conversationConfirmPath(runId), { method: 'POST', body: JSON.stringify(body) }),
  };
}

/** A key the server can fold a repeat into. A retry re-sends the key it already had; it never mints a new one. */
export function newIdempotencyKey(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

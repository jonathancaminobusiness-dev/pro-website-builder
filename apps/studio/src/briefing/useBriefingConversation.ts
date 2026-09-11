import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { briefingClosed, type ConversationTurn } from './contract.js';
import { newIdempotencyKey, type ConversationClient } from './client.js';
import { classifyFailure, conversationReducer, initialConversationState, type ConversationUiState, type PendingIntent } from './machine.js';

export interface BriefingConversationController {
  state: ConversationUiState;
  /** The summary the captain closed, or null while the briefing is still open. */
  closedBriefing: string | null;
  resume: () => void;
  retry: () => void;
  /** Drops the request that failed so the field it came from can be edited and sent again. */
  discard: () => void;
  sendEntry: () => void;
  answer: () => void;
  skip: () => void;
  cancel: () => void;
  confirm: () => void;
  setDraft: (value: string) => void;
  setSummary: (value: string) => void;
  correct: (turn: ConversationTurn) => void;
}

/**
 * Drives the conversation panel. Every request goes through `run`, which is the
 * one place that decides what a failure means, and a retry replays the pending
 * intent object untouched — same body, same idempotency key — so the server
 * folds it into the turn it already has.
 *
 * Opening a run always resumes it from the server. There is no default
 * conversation to fall back to: a run whose conversation the server does not
 * know leaves the panel silent and the old briefing field in charge.
 */
export function useBriefingConversation(client: ConversationClient, runId: string | null): BriefingConversationController {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState());
  const generation = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  const run = useCallback(async (intent: PendingIntent, targetRunId: string): Promise<void> => {
    const epoch = generation.current;
    dispatch({ type: 'begin', intent });
    try {
      const snapshot = intent.kind === 'resume'
        ? await client.resume(targetRunId)
        : intent.kind === 'send'
          ? await client.send(targetRunId, intent.request)
          : await client.confirm(targetRunId, intent.request);
      if (epoch !== generation.current) return;
      if (snapshot === null) dispatch({ type: 'resumed', snapshot: null });
      else dispatch({ type: 'settled', snapshot });
    } catch (cause) {
      if (epoch !== generation.current) return;
      dispatch({ type: 'failed', failure: classifyFailure(cause) });
    }
  }, [client]);

  useEffect(() => {
    generation.current += 1;
    dispatch({ type: 'reset' });
    if (runId) void run({ kind: 'resume' }, runId);
  }, [run, runId]);

  const send = useCallback((intent: 'entry' | 'answer' | 'skip' | 'cancel', message: string): void => {
    if (!runId) return;
    const questionId = latest.current.snapshot?.question?.id;
    void run({ kind: 'send', request: { idempotencyKey: newIdempotencyKey(), intent, message, ...(questionId && (intent === 'answer' || intent === 'skip') ? { questionId } : {}) } }, runId);
  }, [run, runId]);

  return useMemo<BriefingConversationController>(() => ({
    state,
    closedBriefing: state.snapshot && briefingClosed(state.snapshot) ? state.snapshot.summary : null,
    resume: () => { if (runId) void run({ kind: 'resume' }, runId); },
    retry: () => {
      const pending = latest.current.pending;
      if (!pending || !runId) return;
      void run(pending, runId);
    },
    discard: () => dispatch({ type: 'discard' }),
    sendEntry: () => send('entry', latest.current.draft.trim()),
    answer: () => send('answer', latest.current.draft.trim()),
    skip: () => send('skip', ''),
    cancel: () => send('cancel', ''),
    confirm: () => {
      if (!runId) return;
      void run({ kind: 'confirm', request: { idempotencyKey: newIdempotencyKey(), summary: latest.current.summaryDraft.trim() } }, runId);
    },
    setDraft: (value) => dispatch({ type: 'draft', value }),
    setSummary: (value) => dispatch({ type: 'summaryDraft', value }),
    correct: (turn) => dispatch({ type: 'draft', value: turn.message }),
  }), [run, runId, send, state]);
}

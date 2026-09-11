import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationSnapshot } from '../briefing/contract.js';
import { CONSOLIDATED_SUMMARY, conversationSnapshot } from '../briefing/conversation-fixture.js';
import { conversationReducer, initialConversationState } from '../briefing/machine.js';
import type { BriefingConversationController } from '../briefing/useBriefingConversation.js';
import IdentityGate, { type IdentityGateSnapshot, type IdentityDirectionView } from './IdentityGate.js';

const direction: IdentityDirectionView = {
  directionId: 'modular-technical',
  label: 'Modular technical',
  versionId: 'version-direction',
  parentVersionId: 'version-root',
  identityHash: 'identity-hash',
  thesis: 'A measured identity.',
  tension: 'Precision with warmth.',
  rationale: 'The rationale is grounded in the briefing.',
  exclusions: [],
  forbiddenDefaults: { fonts: [], palettes: [], motifs: [] },
  axes: [],
  swatches: [],
  decisions: [],
  lintErrors: [],
  blocking: [],
  scores: [],
  rubricGaps: [],
  unscoredDimensions: [],
  blockedPairs: [],
  abstained: false,
  imagePlans: [],
  imageryViolations: [],
};

function snapshot(status: IdentityGateSnapshot['status'], withResult = false): IdentityGateSnapshot {
  return {
    runId: 'identity-progress-fixture',
    status,
    baseVersionId: 'version-root',
    briefing: 'A deterministic briefing for the Gate 1 interface.',
    directions: withResult ? [direction] : [],
    setCritique: { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
    gate: { state: 'open', reason: 'The captain decides.' },
    approvals: [],
    assets: [],
    failures: [],
  };
}

/** A controller whose only interesting fact here is where its conversation stands. */
function controllerFor(snapshot: ConversationSnapshot | null): BriefingConversationController {
  const state = conversationReducer(initialConversationState('identity-progress-fixture'), { type: 'resumed', snapshot });
  const noop = (): undefined => undefined;
  return {
    state,
    closedBriefing: snapshot && snapshot.state === 'final' && snapshot.closedAt !== undefined ? snapshot.summary : null,
    resume: noop, retry: noop, discard: noop, sendEntry: noop, answer: noop, skip: noop, cancel: noop, confirm: noop,
    setDraft: noop, setSummary: noop, correct: noop,
  };
}

function renderGate(next: IdentityGateSnapshot, busy = false, inFlight = false, conversation?: BriefingConversationController): string {
  return renderToStaticMarkup(createElement(IdentityGate, {
    snapshot: next,
    busy,
    error: '',
    onCreate: () => undefined,
    onOpen: () => undefined,
    unreachableRunId: '',
    onRetry: () => undefined,
    onStart: () => undefined,
    onCancel: () => undefined,
    startRecoveryPending: false,
    onApprove: () => undefined,
    onReject: () => undefined,
    onChangeToken: () => undefined,
    previewOrigin: 'http://127.0.0.1:4311',
    inFlight,
    ...(conversation ? { conversation } : {}),
  }));
}

describe('Gate 1 execution progress', () => {
  it.each([
    ['queued', 'pronto para executar', 'Executar etapa de identidade'],
    ['running', 'executando', 'Etapa em execução'],
    ['needs_review', 'aguarda gate', 'Etapa executada'],
    ['failed', 'falhou', 'Tentar novamente'],
    ['cancelled', 'cancelada', 'Execução cancelada'],
  ] as const)('renders the %s status and matching primary action', (status, label, action) => {
    const markup = renderGate(snapshot(status, status === 'needs_review'));

    expect(markup).toContain(`status-${status}`);
    expect(markup).toContain(label);
    expect(markup).toContain(action);
  });

  it('derives the cancel action from a running server snapshot', () => {
    const markup = renderGate(snapshot('running'));

    expect(markup).toContain('Cancelar execução');
    expect(markup).not.toContain('pronto para executar');
  });

  it('keeps a failed server status visible while the start request is busy', () => {
    const markup = renderGate(snapshot('failed'), true);

    expect(markup).toContain('falhou');
    expect(markup).toContain('Tentar novamente');
    expect(markup).not.toContain('Executando…');
  });

  it('keeps a queued server status visible while the start request is pending', () => {
    const markup = renderGate(snapshot('queued'), false, true);

    expect(markup).toContain('status-queued');
    expect(markup).toContain('pronto para executar');
    expect(markup).toContain('Iniciando…');
    expect(markup).toContain('Cancelar execução');
  });

  it('refuses to spend the identity stage while the briefing conversation is still open', () => {
    const markup = renderGate(snapshot('queued'), false, false, controllerFor(conversationSnapshot({ state: 'question', messageCount: 2 })));

    expect(markup).toContain('Feche o briefing para executar');
    expect(markup).toContain('disabled="">Feche o briefing para executar');
    expect(markup).not.toContain('>Executar etapa de identidade<');
  });

  it('holds the identity stage closed while the conversation is still being read', () => {
    const pending: BriefingConversationController = { ...controllerFor(null), state: initialConversationState('identity-progress-fixture') };
    const markup = renderGate(snapshot('queued'), false, false, pending);

    expect(markup).toContain('Abrindo a conversa desta execução…');
    expect(markup).toContain('disabled="">Abrindo a conversa desta execução…');
    expect(markup).not.toContain('>Executar etapa de identidade<');
  });

  it('names a conversation it could not read instead of a read still running, and keeps the stage closed', () => {
    const unreadable: BriefingConversationController = {
      ...controllerFor(null),
      state: conversationReducer(
        conversationReducer(initialConversationState('identity-progress-fixture'), { type: 'begin', intent: { kind: 'resume' } }),
        { type: 'failed', failure: { message: 'Falha ao ler a conversa.' } },
      ),
    };
    const markup = renderGate(snapshot('queued'), false, false, unreadable);

    expect(markup).toContain('disabled="">Não foi possível abrir a conversa desta execução');
    expect(markup).not.toContain('Abrindo a conversa desta execução…');
    expect(markup).not.toContain('>Executar etapa de identidade<');
  });

  it('enables the identity stage once the captain closed the briefing', () => {
    const markup = renderGate(snapshot('queued'), false, false, controllerFor(conversationSnapshot({ state: 'final', summary: CONSOLIDATED_SUMMARY, closedAt: '2026-09-11T09:00:00.000Z', messageCount: 4 })));

    expect(markup).toContain('>Executar etapa de identidade<');
    expect(markup).not.toContain('Feche o briefing para executar');
  });

  it('leaves the old flow starting the stage when the server has no conversation for the run', () => {
    const markup = renderGate(snapshot('queued'), false, false, controllerFor(null));

    expect(markup).toContain('>Executar etapa de identidade<');
    expect(markup).not.toContain('Feche o briefing para executar');
  });

  it('keeps the completed Gate 1 result visible after progress settles', () => {
    const markup = renderGate(snapshot('needs_review', true));

    expect(markup).toContain('Modular technical');
    expect(markup).toContain('Aprovar esta direção');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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

function renderGate(next: IdentityGateSnapshot, busy = false, inFlight = false): string {
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

  it('keeps the completed Gate 1 result visible after progress settles', () => {
    const markup = renderGate(snapshot('needs_review', true));

    expect(markup).toContain('Modular technical');
    expect(markup).toContain('Aprovar esta direção');
  });
});

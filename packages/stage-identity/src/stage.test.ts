import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentResult, type AgentTask } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import { HiggsfieldMcpProvider, type ModelProvider } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import { identityAxisBriefs } from './axes.js';
import { imageryPolicyViolations } from './art-director.js';
import { FakeIdentityProvider, fakeIdentityFor } from './fake-identity-provider.js';
import { identityChangeImpact, identityHash } from './gate.js';
import { IdentityStage } from './stage.js';

const BRIEFING = 'Uma oficina de produto autoral precisa explicar seu processo sem parecer agência. A prova é o registro de cada decisão.';

function seedStore(): { store: VersionStore; baseVersionId: string } {
  const store = new VersionStore();
  const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
  return { store, baseVersionId: root.id };
}

interface StageHarness { stage: IdentityStage; store: VersionStore; baseVersionId: string; events: Array<{ type: string; payload: Record<string, unknown> }>; }

function harness(options: { provider?: ModelProvider; scheduler?: Scheduler; raster?: ConstructorParameters<typeof HiggsfieldMcpProvider>[0] } = {}): StageHarness {
  const { store, baseVersionId } = seedStore();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const stage = new IdentityStage({
    runId: 'run-identity-test',
    baseVersionId,
    briefing: BRIEFING,
    provider: options.provider ?? new FakeIdentityProvider(),
    store,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    raster: new HiggsfieldMcpProvider(options.raster ?? { configured: false }),
    onEvent: (type, payload) => { events.push({ type, payload }); },
    now: () => '2026-09-07T12:00:00.000Z',
  });
  return { stage, store, baseVersionId, events };
}

describe('identity stage fan-out', () => {
  it('turns one briefing into three sibling directions that never merge', async () => {
    const { stage, store, baseVersionId } = harness();
    const result = await stage.run();

    expect(result.candidates.map((candidate) => candidate.directionId).sort()).toEqual(identityAxisBriefs.map((seat) => seat.id).sort());
    expect(new Set(result.candidates.map((candidate) => candidate.versionId)).size).toBe(3);
    for (const candidate of result.candidates) {
      expect(candidate.parentVersionId).toBe(baseVersionId);
      expect(store.get(candidate.versionId)?.parentId).toBe(baseVersionId);
      expect(candidate.identityHash).toBe(identityHash(store.get(candidate.versionId)!.ir));
    }
    // The base version still holds the identity it started with: no branch was merged into it.
    expect(store.get(baseVersionId)!.ir.identity.meta.id).toBe('fixture-identity');
  });

  it('passes DIV-030 and ID-003 for every direction, and each one still renders', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    expect(result.divergence.blockedPairs).toEqual([]);
    expect(result.divergence.passed).toBe(true);
    expect(result.divergence.pairs).toHaveLength(3);
    for (const pair of result.divergence.pairs) expect(pair.distinctAxes.length).toBeGreaterThanOrEqual(4);
    for (const candidate of result.candidates) {
      expect(candidate.lint.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      expect(renderDesign(store.get(candidate.versionId)!.ir).routes).toHaveLength(3);
    }
  });

  it('holds the fan-out to the scheduler lane limit instead of starting every director at once', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try { return await inner.propose(task, signal); } finally { active -= 1; }
      },
    };
    const { stage } = harness({ provider, scheduler: new Scheduler({ maxActiveClaude: 2, maxActiveRaster: 1 }) });
    await stage.run();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('records the brief the curator extracted, with its evidence ids', async () => {
    const { stage } = harness();
    const result = await stage.run();
    expect(result.brief.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.brief.assumptions[0]?.risk).toBe('low');
    for (const candidate of result.candidates) {
      const cited = new Set(candidate.identity.decisions.flatMap((decision) => decision.evidenceIds));
      for (const id of cited) expect(result.brief.evidence.map((entry) => entry.id)).toContain(id);
    }
  });

  it('discards a critic that tries to patch the document and keeps the reason', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (!task.id.startsWith('identity-critic-')) return result;
        return { ...result, proposal: { operations: [{ op: 'replace', path: '/identity/meta/id', value: 'critic-wrote-this' }], baseVersionId: task.baseVersionId, touchedPaths: ['/identity/meta/id'], rationale: 'A critic must not do this.', confidence: 1, stage: 'identity', role: 'critic' } };
      },
    };
    const { stage, store } = harness({ provider });
    const result = await stage.run();
    expect(result.critiques).toEqual([]);
    expect(result.failures.filter((failure) => /critics are read-only/.test(failure.reason)).length).toBeGreaterThan(0);
    for (const candidate of result.candidates) expect(store.get(candidate.versionId)!.ir.identity.meta.id).not.toBe('critic-wrote-this');
  });

  it('survives one director failing its contract as long as two directions remain', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id === 'identity-director-modular-technical') return { taskId: task.id, status: 'succeeded', summary: 'no artifact' };
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    expect(result.candidates.map((candidate) => candidate.directionId)).toEqual(['editorial-material', 'typographic-low-chroma']);
    expect(result.failures.some((failure) => failure.taskId === 'identity-director-modular-technical')).toBe(true);
  });

  it('stops the stage when the fan-out cannot produce two comparable directions', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-director-') && task.id !== 'identity-director-editorial-material') return { taskId: task.id, status: 'succeeded', summary: 'no artifact' };
        return inner.propose(task, signal);
      },
    };
    await expect(harness({ provider }).stage.run()).rejects.toThrow(/needs at least two/i);
  });

  it('spends at most one refinement cycle and applies it onto the branch it repairs', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (!task.id.startsWith('identity-critic-brand-fit-critic-editorial-material')) return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'brand-fit', score: 2, evidence: 'A prova não aparece antes da dobra.' }], findings: [{ id: 'bf-1', dimension: 'brand-fit', severity: 'error', path: '/identity/direction/thesis', observation: 'A tese não cita a prova.', why: 'O público avalia processo, não promessa.', evidenceIds: ['ev-proof'], confidence: 0.7 }] } };
      },
    };
    const { stage, store } = harness({ provider });
    const result = await stage.run();
    expect(refinerCalls).toEqual(['identity-refiner-editorial-material']);
    const repaired = result.candidates.find((candidate) => candidate.directionId === 'editorial-material')!;
    expect(repaired.refinedFromVersionId).toBeDefined();
    expect(repaired.versionId).not.toBe(repaired.refinedFromVersionId);
    // The refinement is a child of the candidate branch, not a new sibling of the base.
    expect(store.get(repaired.versionId)!.parentId).toBe(repaired.refinedFromVersionId);
  });
});

describe('image art director', () => {
  it('plans for every direction but generates nothing before the captain decides', async () => {
    const { stage, events } = harness();
    const result = await stage.run();
    expect(result.candidates.every((candidate) => candidate.imagePlan)).toBe(true);
    expect(events.filter((event) => event.type === 'identity.imagery.generated')).toEqual([]);
    expect(events.find((event) => event.type === 'identity.imagery.planned')?.payload).toMatchObject({ plans: 3, generated: 0 });
  });

  it('generates only the approved direction and records provenance and licence per image', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { stage } = harness({ raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    const result = await stage.run();
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    expect(calls).toHaveLength(result.candidates.find((candidate) => candidate.directionId === 'modular-technical')!.imagePlan!.plans.length);
    expect(approval.assets).toHaveLength(1);
    const [asset] = approval.assets;
    expect(asset?.status).toBe('ready');
    expect(asset?.provenance.license).toBe('provider terms 2026');
    expect(asset?.provenance.prompt).toBeTruthy();
    expect(asset?.provenance.termsNote).toMatch(/Expected licence:/);
    expect(asset?.alt).toBeTruthy();
  });

  it('still records provenance when Higgsfield is not configured, instead of leaving a silent gap', async () => {
    const { stage } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'editorial-material', rationale: 'Direção aprovada.', approverRole: 'captain' });
    expect(approval.assets[0]?.status).toBe('placeholder');
    expect(approval.assets[0]?.provenance.source).toMatch(/not configured/);
    expect(approval.assets[0]?.provenance.license).toBeTruthy();
  });

  it('refuses a plan that smuggles photography into a direction that declared none', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'typographic-low-chroma')!;
    expect(candidate.imageryViolations).toEqual([]);
    const smuggled = { ...candidate.imagePlan!, plans: [{ ...candidate.imagePlan!.plans[0]!, role: 'portrait' as const }] };
    expect(imageryPolicyViolations(smuggled, store.get(candidate.versionId)!.ir)[0]).toMatch(/no-photography/);
  });
});

describe('gate 1', () => {
  it('accepts only the captain', async () => {
    const { stage } = harness();
    await stage.run();
    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'x', approverRole: 'designer' })).rejects.toThrow(/Only the captain/);
  });

  it('refuses a direction that is not one of the candidates', async () => {
    const { stage } = harness();
    await stage.run();
    await expect(stage.approve({ directionId: 'invented', rationale: 'x', approverRole: 'captain' })).rejects.toThrow(/not one of this run/);
  });

  it('blocks automatic selection when a check fails, and lets the captain override in writing', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, findings: [{ id: 'a11y-1', dimension: 'system-accessibility', severity: 'veto', path: '/identity/tokens/color/muted', observation: 'O par de texto secundário não alcança AA.', why: 'Texto de anotação fica ilegível.', evidenceIds: [], confidence: 0.9 }] } };
      },
    };
    const { stage } = harness({ provider });
    await stage.run();
    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/automatic selection is not allowed/);
    const approved = await stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'O veto é sobre um papel que esta rota não usa; registrado para o Gate 2.' });
    expect(approved.record.directionId).toBe('editorial-material');
  });

  it('hands the next stage a hash of the approved identity, not of the whole document', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    const chosen = result.candidates.find((candidate) => candidate.directionId === 'typographic-low-chroma')!;
    const approval = await stage.approve({ directionId: chosen.directionId, rationale: 'A direção tipográfica sustenta o argumento.', approverRole: 'captain' });
    expect(approval.record.identityHash).toBe(identityHash(store.get(chosen.versionId)!.ir));
    expect(approval.record.identityHash).not.toBe(identityHash(store.get(result.baseVersionId)!.ir));
    expect(stage.gateState().state).toBe('closed');
  });

  it('reopens after a token change and names the renders the change made unreachable', async () => {
    const { stage, store, events } = harness();
    const result = await stage.run();
    const chosen = result.candidates.find((candidate) => candidate.directionId === 'modular-technical')!;
    await stage.approve({ directionId: chosen.directionId, rationale: 'Aprovada.', approverRole: 'captain' });
    const approvedIr = store.get(chosen.versionId)!.ir;

    const changed = await stage.changeToken({ tokenPath: 'color.accent', value: { $value: '#ff5c00', $type: 'color' }, rationale: 'O capitão pediu um sinal mais quente.' });
    expect(changed.gate.state).toBe('reopened');
    if (changed.gate.state !== 'reopened') throw new Error('unreachable');
    expect(changed.gate.impact.changedTokenPaths).toEqual(['color.accent']);
    expect(changed.gate.impact.staleRenderKeys.length).toBeGreaterThan(0);

    const currentIr = store.get(changed.versionId)!.ir;
    const impact = identityChangeImpact(approvedIr, currentIr);
    expect(impact.reopensGate).toBe(true);
    // Every render key the approved identity produced is gone; none survives into the new version.
    const nextKeys = new Set(identityChangeImpact(currentIr, approvedIr).staleRenderKeys);
    for (const key of impact.staleRenderKeys) expect(nextKeys.has(key)).toBe(false);
    expect(events.some((event) => event.type === 'identity.gate.reopened')).toBe(true);
  });

  it('does not reopen for a change that leaves the identity untouched', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    const chosen = result.candidates[0]!;
    await stage.approve({ directionId: chosen.directionId, rationale: 'Aprovada.', approverRole: 'captain' });
    const ir = store.get(chosen.versionId)!.ir;
    const withNewPageTitle = { ...ir, pages: { routes: ir.pages.routes.map((page, index) => index === 0 ? { ...page, title: 'Outro título' } : page) } };
    expect(identityChangeImpact(ir, withNewPageTitle).reopensGate).toBe(false);
    expect(stage.gateState().state).toBe('closed');
  });

  it('refuses to change a token the approved identity does not define', async () => {
    const { stage } = harness();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.changeToken({ tokenPath: 'color.ghost', value: { $value: '#000000', $type: 'color' }, rationale: 'x' })).rejects.toThrow(/is not defined/);
  });
});

describe('fake identity provider', () => {
  it('keeps the token contract constant across the three directions so the pages keep resolving', () => {
    const paths = identityAxisBriefs.map((seat) => {
      const identity = fakeIdentityFor(seat.id);
      return JSON.stringify(Object.entries(identity.tokens).map(([group, entries]) => [group, Object.keys(entries as Record<string, unknown>).sort()]).sort());
    });
    expect(new Set(paths).size).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createFixtureIR, flattenTokens, type AgentResult, type AgentTask } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import { IDENTITY_ALLOWED_PATHS, IDENTITY_TASK_SCOPE } from './stage.js';
import { HiggsfieldMcpProvider, type ModelProvider } from '@pwb/providers';
import { lintDesign } from '@pwb/linter';
import { renderDesign } from '@pwb/renderer';
import { identityAxisBriefs } from './axes.js';
import { generateImageAsset, imageryPolicyViolations, plannedImagery } from './art-director.js';
import { directionVectorDraftSchemaFor, type ImagePromptPlan } from './contracts.js';
import { FakeIdentityProvider, fakeIdentityFor } from './fake-identity-provider.js';
import { identityChangeImpact, identityHash } from './gate.js';
import { defaultIdentityDeadlines, IdentityStage, type IdentityStageDeadlines } from './stage.js';
import { stageRoles } from '@pwb/domain';

const BRIEFING = 'Uma oficina de produto autoral precisa explicar seu processo sem parecer agência. A prova é o registro de cada decisão.';

function seedStore(): { store: VersionStore; baseVersionId: string } {
  const store = new VersionStore();
  const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
  return { store, baseVersionId: root.id };
}

interface StageHarness { stage: IdentityStage; store: VersionStore; baseVersionId: string; events: Array<{ type: string; payload: Record<string, unknown> }>; }

function harness(options: { provider?: ModelProvider; scheduler?: Scheduler; deadlines?: Partial<IdentityStageDeadlines>; raster?: ConstructorParameters<typeof HiggsfieldMcpProvider>[0]; onEvent?: (type: string, payload: Record<string, unknown>) => void } = {}): StageHarness {
  const { store, baseVersionId } = seedStore();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const stage = new IdentityStage({
    runId: 'run-identity-test',
    baseVersionId,
    briefing: BRIEFING,
    provider: options.provider ?? new FakeIdentityProvider(),
    store,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.deadlines ? { deadlines: options.deadlines } : {}),
    raster: new HiggsfieldMcpProvider(options.raster ?? { configured: false }),
    onEvent: (type, payload) => { events.push({ type, payload }); options.onEvent?.(type, payload); },
    now: () => '2026-09-07T12:00:00.000Z',
  });
  return { stage, store, baseVersionId, events };
}

describe('identity stage fan-out', () => {
  it('keeps the three-minute deadline for regular critics and gives system accessibility more room by default', () => {
    expect(defaultIdentityDeadlines.critic).toBe(3 * 60_000);
    expect(defaultIdentityDeadlines.criticById?.['system-a11y-critic']).toBe(10 * 60_000);
  });

  it('opens Gate 1 without critic failures under the default deadline policy', async () => {
    const { stage, events } = harness();
    const result = await stage.run();
    const queued = events.filter((event) => event.type === 'identity.task.queued');
    const deadlineOf = (taskId: string): unknown => queued.find((event) => event.payload.taskId === taskId)?.payload.deadlineMs;

    expect(result.gate.state).toBe('open');
    expect(result.failures).toEqual([]);
    expect(deadlineOf('identity-critic-brand-fit-critic-editorial-material')).toBe(3 * 60_000);
    expect(deadlineOf('identity-critic-divergence-critic')).toBe(3 * 60_000);
    expect(deadlineOf('identity-critic-system-a11y-critic-editorial-material')).toBe(10 * 60_000);
  });

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

  it('gives Codex identity directors the full invocation window', async () => {
    const inner = new FakeIdentityProvider();
    const directorDeadlines: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.role === 'director') directorDeadlines.push(task.deadlineMs);
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider });

    await stage.run();

    expect(directorDeadlines).toHaveLength(3);
    expect(new Set(directorDeadlines)).toEqual(new Set([defaultIdentityDeadlines.director]));
    expect(defaultIdentityDeadlines.director).toBe(7 * 60_000);
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

  it('blocks DIV-030 when two directions converge on what they actually built', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        const mine = task.id === 'identity-director-modular-technical' || task.id === 'identity-refiner-modular-technical';
        if (!mine || !result.proposal) return result;
        // The modular seat argues its own strategy but ships the editorial document, and keeps shipping it after the repair.
        const converged = { ...fakeIdentityFor('editorial-material'), meta: fakeIdentityFor('modular-technical').meta, direction: fakeIdentityFor('modular-technical').direction };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: converged }] } };
      },
    };
    const { stage, store } = harness({ provider });
    const result = await stage.run();
    expect(result.divergence.passed).toBe(false);
    expect(result.divergence.blockedPairs.join(' ')).toMatch(/editorial-material and modular-technical/);
    // The rule reads the same way from the document the captain would approve.
    const modular = result.candidates.find((candidate) => candidate.directionId === 'modular-technical')!;
    expect(lintDesign(store.get(modular.versionId)!.ir).findings.some((finding) => finding.id === 'DIV-030')).toBe(true);
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Aprovada.', approverRole: 'captain' })).rejects.toThrow(/automatic selection is not allowed/);
  });

  it('never asks a refiner to clear a distance between two other documents', async () => {
    const inner = new FakeIdentityProvider();
    const briefs: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id === 'identity-refiner-typographic-low-chroma') briefs.push(task.brief);
        const result = await inner.propose(task, signal);
        if (task.id === 'identity-critic-system-a11y-critic-typographic-low-chroma') {
          const report = result.artifact as Record<string, unknown>;
          return { ...result, artifact: { ...report, scores: [{ dimension: 'system-accessibility', score: 2, evidence: 'Contraste do texto de anotação.' }] } };
        }
        if (task.id !== 'identity-director-modular-technical' || !result.proposal) return result;
        const converged = { ...fakeIdentityFor('editorial-material'), meta: fakeIdentityFor('modular-technical').meta, direction: fakeIdentityFor('modular-technical').direction };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: converged }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    expect(result.divergence.blockedPairs.join(' ')).toMatch(/editorial-material and modular-technical/);
    expect(briefs).toHaveLength(1);
    // The repair brief names only what this direction can answer for.
    const findings = JSON.parse(briefs[0]!.match(/The blocking findings you must clear:\n(\{.*\})/)![1]!) as { lint: Array<{ id: string; message: string }> };
    expect(findings.lint.some((finding) => /differ on \d+ of the required/.test(finding.message))).toBe(false);
  });

  it('keeps a failing DIV-030 pair on the set: no refinement, and only the two directions in it are blocked', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-modular-technical' || !result.proposal) return result;
        const converged = { ...fakeIdentityFor('editorial-material'), meta: fakeIdentityFor('modular-technical').meta, direction: fakeIdentityFor('modular-technical').direction };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: converged }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    expect(result.divergence.blockedPairs.join(' ')).toMatch(/editorial-material and modular-technical/);
    // No per-direction repair can move a distance between two other documents, so none is attempted.
    expect(refinerCalls).toEqual([]);
    for (const directionId of ['editorial-material', 'modular-technical'] as const) {
      await expect(stage.approve({ directionId, rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/editorial-material and modular-technical differ/);
    }
    // The direction that is in no failing pair is not answerable for that distance.
    const approved = await stage.approve({ directionId: 'typographic-low-chroma', rationale: 'A direção tipográfica responde ao briefing.', approverRole: 'captain' });
    expect(approved.record.directionId).toBe('typographic-low-chroma');
  });

  it('builds the same matrix whatever order the directors answer in', async () => {
    const runWith = async (delays: Record<string, number>) => {
      const inner = new FakeIdentityProvider();
      const provider: ModelProvider = {
        async propose(task, signal) {
          const delay = delays[task.id];
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          return inner.propose(task, signal);
        },
      };
      return (await harness({ provider }).stage.run()).candidates;
    };
    const inOrder = await runWith({ 'identity-director-typographic-low-chroma': 12 });
    const reversed = await runWith({ 'identity-director-editorial-material': 12, 'identity-director-modular-technical': 6 });
    expect(inOrder.map((candidate) => candidate.directionId)).toEqual(identityAxisBriefs.map((seat) => seat.id));
    expect(reversed.map((candidate) => candidate.directionId)).toEqual(identityAxisBriefs.map((seat) => seat.id));
    // Byte-identical answers produce the same versions whichever director returns first.
    expect(reversed.map((candidate) => candidate.identityHash)).toEqual(inOrder.map((candidate) => candidate.identityHash));
    expect(reversed.map((candidate) => candidate.versionId)).toEqual(inOrder.map((candidate) => candidate.versionId));
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

  it('records a critic that exceeds its configured default deadline', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id === 'identity-critic-system-a11y-critic-editorial-material') {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 20);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('critic cancelled')); }, { once: true });
          });
        }
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider, deadlines: { critic: 5 } });

    const result = await stage.run();

    expect(result.failures.some((failure) => failure.taskId === 'identity-critic-system-a11y-critic-editorial-material' && /deadline/i.test(failure.reason))).toBe(true);
    expect(result.candidates.find((candidate) => candidate.directionId === 'editorial-material')?.unscoredDimensions).toContain('system-accessibility');
  });

  it('uses a per-critic deadline override when a critic needs more time', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id === 'identity-critic-system-a11y-critic-editorial-material') {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 20);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('critic cancelled')); }, { once: true });
          });
        }
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider, deadlines: { critic: 5, criticById: { 'system-a11y-critic': 50 } } });

    const result = await stage.run();

    expect(result.failures.some((failure) => failure.taskId === 'identity-critic-system-a11y-critic-editorial-material')).toBe(false);
    expect(result.candidates.find((candidate) => candidate.directionId === 'editorial-material')?.scores).toContainEqual({ criticId: 'system-a11y-critic', dimension: 'system-accessibility', score: 4 });
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

  it('records a non-succeeded provider result as a task failure', async () => {
    const provider: ModelProvider = {
      async propose(task) {
        return { taskId: task.id, status: 'needs_review', summary: 'Codex returned an invalid structured proposal.', errorCode: 'SCHEMA_INVALID' };
      },
    };
    const { stage } = harness({ provider });

    await expect(stage.run()).rejects.toThrow(/Codex returned an invalid structured proposal/);
    expect(stage.recordedFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'identity-curator', reason: expect.stringMatching(/Codex returned an invalid structured proposal/) }),
    ]));
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

  it('keeps the healthy branches when one director\u2019s identity cannot be applied', async () => {
    const inner = new FakeIdentityProvider();
    const criticCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-critic-')) criticCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-modular-technical' || !result.proposal) return result;
        // A token vocabulary the fixture pages still reference: schema-valid, but no document can be built from it.
        const identity = fakeIdentityFor('modular-technical');
        const { display: _display, ...type } = identity.tokens.type as Record<string, unknown>;
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: { ...identity, tokens: { ...identity.tokens, type } } }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    expect(result.candidates.map((candidate) => candidate.directionId)).toEqual(['editorial-material', 'typographic-low-chroma']);
    expect(result.failures.some((failure) => failure.taskId === 'identity-director-modular-technical')).toBe(true);
    expect(result.gate.state).toBe('open');
    // The survivors were re-synced with the smaller matrix; neither of them was refined.
    expect(result.candidates.map((candidate) => candidate.refinedFromVersionId)).toEqual([undefined, undefined]);
    expect(criticCalls.filter((id) => id === 'identity-critic-brand-fit-critic-editorial-material')).toHaveLength(1);
  });

  it('attributes a critique to the seat it was asked about, not to the subject the critic declares', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-typographic-low-chroma') return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, subject: { kind: 'direction', directionId: 'Documento tipográfico' }, findings: [{ id: 'a11y-9', dimension: 'system-accessibility', severity: 'veto', path: '/identity/tokens/color/muted', observation: 'O par de texto secundário não alcança AA.', why: 'Texto de anotação fica ilegível.', evidenceIds: [], confidence: 0.9 }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const typographic = result.candidates.find((candidate) => candidate.directionId === 'typographic-low-chroma')!;
    expect(typographic.blocking.map((finding) => finding.id)).toEqual(['a11y-9']);
    for (const other of result.candidates.filter((candidate) => candidate.directionId !== 'typographic-low-chroma')) expect(other.blocking).toEqual([]);
    // The veto is on the card it belongs to, so Gate 1 cannot be closed for it without an override.
    await expect(stage.approve({ directionId: 'typographic-low-chroma', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/automatic selection is not allowed/);
  });

  it('keeps only the scores the seat owns, so one critic cannot block a dimension it has no rubric for', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        // The brand-fit seat was given the brand-fit rubric only; the second score is not its to give.
        return { ...result, artifact: { ...report, dimension: 'system-accessibility', scores: [
          { dimension: 'brand-fit', score: 4, evidence: 'A tese cita a prova.' },
          { dimension: 'system-accessibility', score: 1, evidence: 'Palpite fora da própria rubrica.' },
        ] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'editorial-material')!;
    expect(candidate.rubricGaps).toEqual([]);
    expect(candidate.scores).toContainEqual({ criticId: 'brand-fit-critic', dimension: 'brand-fit', score: 4 });
    expect(candidate.scores.some((score) => score.criticId === 'brand-fit-critic' && score.dimension === 'system-accessibility')).toBe(false);
    // The report is credited to the dimension its seat owns, whatever it declared.
    expect(result.critiques.find((report) => report.criticId === 'brand-fit-critic' && report.subject.kind === 'direction' && report.subject.directionId === 'editorial-material')!.dimension).toBe('brand-fit');
    // The seat that owns system-accessibility passed the direction, so Gate 1 is not blocked.
    const approved = await stage.approve({ directionId: 'editorial-material', rationale: 'A oficina editorial responde ao briefing.', approverRole: 'captain' });
    expect(approved.record.directionId).toBe('editorial-material');
  });

  it('keeps the veto of a critic that scored nothing in its own rubric', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        // Every score names a rubric this seat was not given; the veto is still its own.
        return { ...result, artifact: { ...report, scores: [{ dimension: 'divergence', score: 1, evidence: 'Rubrica que este assento não recebeu.' }], findings: [{ id: 'bf-veto', dimension: 'brand-fit', severity: 'veto', path: '/identity/direction/rationale', observation: 'A rationale não cita nenhuma evidência do briefing.', why: 'A escolha não pode ser auditada.', evidenceIds: [], confidence: 0.9 }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'editorial-material')!;
    // The score is not the seat's to give, so it contributes no gap; the veto reaches the card.
    expect(candidate.rubricGaps).toEqual([]);
    expect(candidate.blocking.map((finding) => finding.id)).toContain('bf-veto');
    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/automatic selection is not allowed/);
  });

  it('keeps a set-level veto on the set, off the cards and out of the refinement cycle', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-divergence-critic') return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, abstain: true, findings: [{ id: 'div-veto', dimension: 'divergence', severity: 'veto', path: '/identity/direction/divergence', observation: 'Duas direções não se distinguem por descrição.', why: 'O capitão compararia duas versões da mesma proposta.', evidenceIds: [], confidence: 0.8 }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    // No per-direction repair can clear a judgement about the set, so none is attempted.
    expect(refinerCalls).toEqual([]);
    expect(result.setCritique.blocking.map((finding) => finding.id)).toEqual(['div-veto']);
    expect(result.setCritique.abstained).toBe(true);
    for (const candidate of result.candidates) {
      expect(candidate.blocking).toEqual([]);
      expect(candidate.abstained).toBe(false);
      expect(candidate.refinedFromVersionId).toBeUndefined();
    }
    // It still blocks every direction until the captain writes an override.
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/div-veto about the fan-out as a whole/);
    const approved = await stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'A divergência medida passa DIV-030; o veto do crítico fica registrado.' });
    expect(approved.record.directionId).toBe('modular-technical');
  });

  it('treats a re-critique that scored nothing of its own as an unevaluated rubric', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const evidence = 'O par de texto de anotação sobre papel não alcança AA.';
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        // The second read answers about a rubric this seat was never given, so it
        // re-read the document but not the rubric its score is supposed to move.
        return refinerCalls.length > 0
          ? { ...result, artifact: { ...report, scores: [{ dimension: 'brand-fit', score: 4, evidence: 'Rubrica que este assento não recebeu.' }] } }
          : { ...result, artifact: { ...report, scores: [{ dimension: 'system-accessibility', score: 2, evidence }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const repaired = result.candidates.find((entry) => entry.directionId === 'editorial-material')!;
    expect(refinerCalls).toEqual(['identity-refiner-editorial-material']);
    expect(repaired.refinedFromVersionId).toBeDefined();
    // The pre-repair score described a version nobody approved, so the card does
    // not carry it forward; the rubric is simply unevaluated for the repair.
    expect(repaired.rubricGaps).toEqual([]);
    expect(repaired.scores.some((score) => score.dimension === 'system-accessibility')).toBe(false);
    expect(repaired.unscoredDimensions).toEqual(['system-accessibility']);
    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/Rubric system-accessibility was never evaluated/);
  });

  it('blocks every direction when the set rubric was never evaluated', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-divergence-critic') return result;
        attempts.push(task.attempt);
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'brand-fit', score: 4, evidence: 'Rubrica que este assento não recebeu.' }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    // The one correction was spent and the only matrix seat still scored nothing it owns.
    expect(attempts).toEqual([1, 2]);
    expect(result.setCritique.unscoredDimensions).toEqual(['divergence']);
    expect(result.setCritique.scores).toEqual([]);
    for (const candidate of result.candidates) expect(candidate.unscoredDimensions).toEqual([]);
    // An unevaluated set rubric is not a passing one: every direction needs the written override.
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/Rubric divergence was never evaluated for the fan-out as a whole/);
    const approved = await stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'A divergência medida passa DIV-030; sigo sem a nota do crítico.' });
    expect(approved.record.directionId).toBe('modular-technical');
  });

  it('keeps a set-level rubric gap on the set, off the cards and out of the refinement cycle', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-divergence-critic') return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'divergence', score: 2, evidence: 'As direções diferem em menos eixos do que a matriz exige.' }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    // A judgement about the fan-out is recorded once, and no direction is refined for it.
    expect(result.setCritique.rubricGaps).toEqual([{ dimension: 'divergence', score: 2, evidence: 'As direções diferem em menos eixos do que a matriz exige.' }]);
    expect(refinerCalls).toEqual([]);
    for (const candidate of result.candidates) {
      expect(candidate.rubricGaps).toEqual([]);
      expect(candidate.refinedFromVersionId).toBeUndefined();
      expect(candidate.scores.some((score) => score.dimension === 'divergence')).toBe(false);
    }
    // It still blocks every direction until the captain writes an override.
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/for the fan-out as a whole/);
    const approved = await stage.approve({ directionId: 'modular-technical', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'A divergência medida passa DIV-030; sigo com a nota do crítico registrada.' });
    expect(approved.record.directionId).toBe('modular-technical');
  });

  it('tells the refiner what the low score was about, not just that it was low', async () => {
    const inner = new FakeIdentityProvider();
    const briefs: string[] = [];
    const evidence = 'O par de texto de anotação sobre papel não alcança AA.';
    const summary = 'O sistema lê bem no corpo principal e falha nas anotações.';
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id === 'identity-refiner-editorial-material') briefs.push(task.brief);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, summary, scores: [{ dimension: 'system-accessibility', score: 2, evidence }] } };
      },
    };
    const { stage } = harness({ provider });
    await stage.run();
    // The emitted repair brief is the interface the refiner acts on: the gap arrives with its cause.
    expect(briefs).toHaveLength(1);
    const rubric = JSON.parse(briefs[0]!.match(/The blocking findings you must clear:\n(\{.*\})/)![1]!) as { rubric: Array<{ criticId: string; dimension: string; score: number; evidence: string; summary: string }> };
    expect(rubric.rubric).toEqual([{ criticId: 'system-a11y-critic', dimension: 'system-accessibility', score: 2, evidence, summary }]);
  });

  it('spends the corrective re-invocation on a critic that scored somebody else\u2019s rubric, and takes the repaired score', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-typographic-low-chroma') return result;
        attempts.push(task.attempt);
        if (task.attempt > 1) return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'brand-fit', score: 4, evidence: 'Rubrica que este assento não recebeu.' }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'typographic-low-chroma')!;
    expect(attempts).toEqual([1, 2]);
    expect(candidate.unscoredDimensions).toEqual([]);
    expect(candidate.scores.some((score) => score.criticId === 'system-a11y-critic' && score.dimension === 'system-accessibility')).toBe(true);
    expect(result.failures).toEqual([]);
    const approved = await stage.approve({ directionId: 'typographic-low-chroma', rationale: 'A direção tipográfica responde ao briefing.', approverRole: 'captain' });
    expect(approved.record.directionId).toBe('typographic-low-chroma');
  });

  it('blocks a direction whose rubric was never evaluated, even after the correction', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-typographic-low-chroma') return result;
        attempts.push(task.attempt);
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'brand-fit', score: 4, evidence: 'Rubrica que este assento não recebeu.' }] } };
      },
    };
    const { stage, events } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'typographic-low-chroma')!;
    // The one correction was spent and the seat still scored nothing it owns.
    expect(attempts).toEqual([1, 2]);
    expect(candidate.unscoredDimensions).toEqual(['system-accessibility']);
    expect(result.failures.some((failure) => failure.taskId === 'identity-critic-system-a11y-critic-typographic-low-chroma')).toBe(true);
    expect(events.some((event) => event.type === 'identity.critic.unscored')).toBe(true);
    // An unevaluated rubric is not a passing rubric: the gate needs a written override.
    await expect(stage.approve({ directionId: 'typographic-low-chroma', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/Rubric system-accessibility was never evaluated/);
    const approved = await stage.approve({ directionId: 'typographic-low-chroma', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'Aceito seguir sem a nota de acessibilidade; o Gate 2 revisa.' });
    expect(approved.record.directionId).toBe('typographic-low-chroma');
    // The other two directions were scored by every seat that owes them one.
    for (const other of result.candidates.filter((entry) => entry.directionId !== 'typographic-low-chroma')) expect(other.unscoredDimensions).toEqual([]);
  });

  it('spends exactly one corrective re-invocation on an artefact that misses its schema', async () => {
    const inner = new FakeIdentityProvider();
    const briefs: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return result;
        briefs.push(task.brief);
        if (task.attempt > 1) return result;
        const { summary: _summary, ...withoutSummary } = result.artifact as Record<string, unknown>;
        return { ...result, artifact: withoutSummary };
      },
    };
    const { stage, events } = harness({ provider });
    const result = await stage.run();
    expect(briefs).toHaveLength(2);
    // The second invocation carries the validation errors the first answer produced.
    expect(briefs[1]).toContain('summary');
    expect(briefs[1]!.startsWith(briefs[0]!)).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.critiques.some((report) => report.criticId === 'brand-fit-critic' && report.subject.kind === 'direction' && report.subject.directionId === 'editorial-material')).toBe(true);
    expect(events.some((event) => event.type === 'identity.task.correction')).toBe(true);
  });

  it('escalates to human review instead of correcting twice', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return result;
        attempts.push(task.attempt);
        const { summary: _summary, ...withoutSummary } = result.artifact as Record<string, unknown>;
        return { ...result, artifact: withoutSummary };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    expect(attempts).toEqual([1, 2]);
    expect(result.failures.some((failure) => failure.taskId === 'identity-critic-brand-fit-critic-editorial-material' && /does not match its schema/.test(failure.reason))).toBe(true);
    expect(result.critiques.some((report) => report.criticId === 'brand-fit-critic' && report.subject.kind === 'direction' && report.subject.directionId === 'editorial-material')).toBe(false);
    // One critic's malformed answer costs its own report, never the stage.
    expect(result.candidates).toHaveLength(3);
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

  it('sends a rubric gap through the one refinement cycle, and the re-scored repair clears it', async () => {
    const inner = new FakeIdentityProvider();
    const refinerCalls: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-refiner-')) refinerCalls.push(task.id);
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        // A sub-minimum score with no veto and no error finding: the gap is the only reason to repair.
        const score = refinerCalls.length > 0 ? 4 : 2;
        return { ...result, artifact: { ...report, scores: [{ dimension: 'system-accessibility', score, evidence: 'Contraste do texto de anotação.' }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const repaired = result.candidates.find((entry) => entry.directionId === 'editorial-material')!;
    expect(refinerCalls).toEqual(['identity-refiner-editorial-material']);
    expect(repaired.refinedFromVersionId).toBeDefined();
    // The critics read the repair and scored it again, so the gate is no longer blocked.
    expect(repaired.rubricGaps).toEqual([]);
    expect(repaired.scores).toContainEqual({ criticId: 'system-a11y-critic', dimension: 'system-accessibility', score: 4 });
    const approved = await stage.approve({ directionId: 'editorial-material', rationale: 'Reparada e aprovada.', approverRole: 'captain' });
    expect(approved.record.versionId).toBeTruthy();
  });

  it('keeps a veto whose critic never read the repair', async () => {
    const inner = new FakeIdentityProvider();
    let brandFitReads = 0;
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return inner.propose(task, signal);
        brandFitReads += 1;
        if (brandFitReads > 1) return { taskId: task.id, status: 'failed', summary: 'The critic exceeded its deadline.' };
        const result = await inner.propose(task, signal);
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, findings: [{ id: 'bf-1', dimension: 'brand-fit', severity: 'error', path: '/identity/direction/thesis', observation: 'A tese não cita a prova.', why: 'O público avalia processo, não promessa.', evidenceIds: ['ev-proof'], confidence: 0.7 }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const repaired = result.candidates.find((candidate) => candidate.directionId === 'editorial-material')!;
    expect(repaired.refinedFromVersionId).toBeDefined();
    expect(brandFitReads).toBe(2);
    // The seat that never answered the second time keeps what it found the first time,
    // score included: nothing replaced the report it wrote.
    expect(repaired.blocking.map((finding) => finding.id)).toEqual(['bf-1']);
    expect(repaired.unscoredDimensions).toEqual([]);
    expect(repaired.scores.some((score) => score.criticId === 'brand-fit-critic' && score.dimension === 'brand-fit')).toBe(true);
    expect(result.failures.some((failure) => failure.taskId === 'identity-critic-brand-fit-critic-editorial-material')).toBe(true);
    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' })).rejects.toThrow(/automatic selection is not allowed/);
  });

  it('lets a refined direction be approved without an override once the critics read the repair', async () => {
    const inner = new FakeIdentityProvider();
    const reads: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-brand-fit-critic-editorial-material') return result;
        reads.push(task.attempt);
        if (reads.length > 1) return result;
        const report = result.artifact as Record<string, unknown>;
        return { ...result, artifact: { ...report, findings: [{ id: 'bf-1', dimension: 'brand-fit', severity: 'error', path: '/identity/direction/thesis', observation: 'A tese não cita a prova.', why: 'O público avalia processo, não promessa.', evidenceIds: ['ev-proof'], confidence: 0.7 }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const repaired = result.candidates.find((candidate) => candidate.directionId === 'editorial-material')!;
    expect(repaired.refinedFromVersionId).toBeDefined();
    // The critics read the repaired version once, so the finding the refiner closed is gone.
    expect(reads).toHaveLength(2);
    expect(repaired.blocking).toEqual([]);
    const approved = await stage.approve({ directionId: 'editorial-material', rationale: 'A direção editorial responde ao briefing.', approverRole: 'captain' });
    expect(approved.record.directionId).toBe('editorial-material');
  });
});

describe('the identity stage write boundary', () => {
  it('may write only the paths the foundation assigns the stage', () => {
    expect(IDENTITY_ALLOWED_PATHS).toEqual(['/identity', '/reviewRecord']);
    expect(IDENTITY_TASK_SCOPE).toEqual({ allowedPaths: ['/identity', '/reviewRecord'], stage: 'identity', role: stageRoles.identity });
  });

  it('cannot reach the asset ledger, which belongs to the stages that place page media', () => {
    const { store, baseVersionId } = seedStore();
    const applier = new Applier(store, new PatchGate());
    const patch = {
      operations: [{ op: 'replace' as const, path: '/assets/items', value: [] }],
      baseVersionId, touchedPaths: ['/assets/items'], rationale: 'An identity worker must not write assets.',
      confidence: 1, stage: 'identity' as const, role: stageRoles.identity, idempotencyKey: 'boundary-assets',
    };
    expect(() => applier.apply(patch, IDENTITY_TASK_SCOPE, baseVersionId)).toThrow(/not allowed/i);
  });

  it('refuses a patch that declares a role other than the one the stage pins', () => {
    const { store, baseVersionId } = seedStore();
    const applier = new Applier(store, new PatchGate());
    const patch = {
      operations: [{ op: 'replace' as const, path: '/reviewRecord', value: { findings: [], approvals: [] } }],
      baseVersionId, touchedPaths: ['/reviewRecord'], rationale: 'A critic must not patch.',
      confidence: 1, stage: 'identity' as const, role: 'critic' as const, idempotencyKey: 'boundary-role',
    };
    expect(() => applier.apply(patch, IDENTITY_TASK_SCOPE, baseVersionId)).toThrow(/declare exactly that stage and role/i);
  });
});

describe('image art director', () => {
  it('plans for every direction that admits generation, and generates nothing before the captain decides', async () => {
    const { stage, events } = harness();
    const result = await stage.run();
    expect(result.candidates.filter((candidate) => candidate.imagePlan).map((candidate) => candidate.directionId)).toEqual(['editorial-material', 'modular-technical']);
    expect(events.filter((event) => event.type === 'identity.imagery.generated')).toEqual([]);
    expect(events.find((event) => event.type === 'identity.imagery.planned')?.payload).toMatchObject({ plans: 2, skipped: 1, generated: 0 });
  });

  it('generates only the approved direction and records provenance and licence per image', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { stage, store } = harness({ raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    const result = await stage.run();
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    // The gate closes on the planned images; the raster lane shoots them after.
    expect(approval.assets.map((entry) => entry.status)).toEqual(['generating']);
    await stage.imagerySettled();
    expect(calls).toHaveLength(result.candidates.find((candidate) => candidate.directionId === 'modular-technical')!.imagePlan!.plans.length);
    expect(stage.approvedImagery).toHaveLength(1);
    const [asset] = stage.approvedImagery;
    expect(asset?.status).toBe('ready');
    expect(asset?.provenance.license).toBe('provider terms 2026');
    expect(asset?.provenance.prompt).toBeTruthy();
    expect(asset?.provenance.termsNote).toMatch(/Expected licence:/);
    expect(asset?.alt).toBeTruthy();
    // The stage may not write /assets, so the imagery travels on the handoff with its licence.
    const handed = stage.handoff()!;
    expect(handed.assets.map((entry) => entry.id)).toEqual(stage.approvedImagery.map((entry) => entry.id));
    expect(handed.assets.every((entry) => entry.provenance.license.trim().length > 0)).toBe(true);
    expect(store.get(handed.versionId)!.ir.assets.items.some((entry) => entry.id.startsWith('asset-modular-technical'))).toBe(false);
  });

  it('still records provenance when Higgsfield is not configured, instead of leaving a silent gap', async () => {
    const { stage } = harness();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Direção aprovada.', approverRole: 'captain' });
    await stage.imagerySettled();
    expect(stage.approvedImagery[0]?.status).toBe('placeholder');
    expect(stage.approvedImagery[0]?.provenance.source).toMatch(/not configured/);
    expect(stage.approvedImagery[0]?.provenance.license).toBeTruthy();
  });

  it('takes two plans under one id as a schema failure, and keeps the corrected plan', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-art-director-modular-technical') return result;
        attempts.push(task.attempt);
        const plan = result.artifact as { plans: Array<Record<string, unknown>> };
        // The asset id is derived from the plan id, so two plans under one id would
        // put two images, and two licences, on the handoff under a single name.
        if (task.attempt === 1) return { ...result, artifact: { ...plan, plans: [plan.plans[0]!, { ...plan.plans[0]!, prompt: 'Outra tomada da mesma medida, em luz difusa e enquadramento aberto.' }] } };
        return result;
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'modular-technical')!;
    expect(attempts).toEqual([1, 2]);
    expect(result.failures).toEqual([]);
    const ids = candidate.imagePlan!.plans.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records a failure when the art director repeats a plan id after its correction', async () => {
    const inner = new FakeIdentityProvider();
    const calls: Array<Record<string, unknown>> = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-art-director-modular-technical') return result;
        const plan = result.artifact as { plans: Array<Record<string, unknown>> };
        return { ...result, artifact: { ...plan, plans: [plan.plans[0]!, { ...plan.plans[0]!, prompt: 'Outra tomada da mesma medida, em luz difusa e enquadramento aberto.' }] } };
      },
    };
    const { stage } = harness({ provider, raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'modular-technical')!;
    expect(candidate.imagePlan).toBeUndefined();
    expect(result.failures.some((failure) => failure.taskId === 'identity-art-director-modular-technical')).toBe(true);
    // Nothing is generated for a plan the stage refused, so no two assets share an id on the handoff.
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'Aprovada.', approverRole: 'captain' });
    expect(calls).toEqual([]);
    expect(approval.assets).toEqual([]);
  });

  it('takes a plan written for another seat as a schema failure, and records it when the mistake repeats', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-art-director-modular-technical') return result;
        attempts.push(task.attempt);
        return { ...result, artifact: { ...(result.artifact as Record<string, unknown>), directionId: 'editorial-material' } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'modular-technical')!;
    expect(attempts).toEqual([1, 2]);
    expect(candidate.imagePlan).toBeUndefined();
    expect(result.failures.some((failure) => failure.taskId === 'identity-art-director-modular-technical')).toBe(true);
    // The seat that answered for itself is untouched by its neighbour's mistake.
    expect(result.candidates.find((entry) => entry.directionId === 'editorial-material')!.imagePlan!.directionId).toBe('editorial-material');
  });

  it('asks each director for the DirectionVectorDraft its own seat is held to', async () => {
    const briefs = new Map<string, string>();
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-director-')) briefs.set(task.id, task.brief);
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider });
    await stage.run();
    for (const seat of identityAxisBriefs) {
      // The emitted prompt is the interface the director answers against: it has
      // to carry the same closed schema the stage parses that seat's answer with,
      // or a live model has no way to know an artifact is expected at all.
      const brief = briefs.get(`identity-director-${seat.id}`)!;
      expect(brief).toContain(JSON.stringify(zodToJsonSchema(directionVectorDraftSchemaFor(seat.id))));
    }
  });

  it('spends the one correction when a director answers for another seat', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-modular-technical') return result;
        attempts.push(task.attempt);
        if (task.attempt > 1) return result;
        return { ...result, artifact: { ...(result.artifact as Record<string, unknown>), directionId: 'editorial-material' } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    // The wrong seat is a schema violation, so it buys the re-invocation instead
    // of costing the branch the fan-out needs.
    expect(attempts).toEqual([1, 2]);
    expect(result.candidates.map((candidate) => candidate.directionId)).toEqual(['editorial-material', 'modular-technical', 'typographic-low-chroma']);
    expect(result.failures).toEqual([]);
  });

  it('keeps the plan when the art director corrects the seat it answered for', async () => {
    const inner = new FakeIdentityProvider();
    const briefs: string[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-art-director-modular-technical') return result;
        briefs.push(task.brief);
        if (task.attempt > 1) return result;
        return { ...result, artifact: { ...(result.artifact as Record<string, unknown>), directionId: 'editorial-material' } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'modular-technical')!;
    expect(briefs).toHaveLength(2);
    // The prompt names the seat the answer must carry, and the correction carries the error the first answer produced.
    expect(briefs[0]).toContain('modular-technical');
    expect(briefs[1]!.startsWith(briefs[0]!)).toBe(true);
    expect(candidate.imagePlan!.directionId).toBe('modular-technical');
    expect(result.failures).toEqual([]);
  });

  it('never asks a direction that admits no generated source for a plan, and never generates for it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const artDirectorTasks: string[] = [];
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-art-director-')) artDirectorTasks.push(task.id);
        return inner.propose(task, signal);
      },
    };
    const { stage } = harness({ provider, raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'typographic-low-chroma')!;
    expect(artDirectorTasks).toEqual(['identity-art-director-editorial-material', 'identity-art-director-modular-technical']);
    expect(candidate.imagePlan).toBeUndefined();
    expect(candidate.imageryViolations).toEqual([]);
    // Approving it is not blocked, and nothing is generated for a direction that admits only manual imagery.
    const approval = await stage.approve({ directionId: 'typographic-low-chroma', rationale: 'O documento tipográfico responde ao briefing.', approverRole: 'captain' });
    expect(calls).toEqual([]);
    expect(approval.assets).toEqual([]);
    expect(stage.handoff()!.assets).toEqual([]);
  });

  it('takes an empty plan list as a schema failure for a direction that does admit generation', async () => {
    const inner = new FakeIdentityProvider();
    const attempts: number[] = [];
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-art-director-modular-technical') return result;
        attempts.push(task.attempt);
        return { ...result, artifact: { ...(result.artifact as Record<string, unknown>), plans: [] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'modular-technical')!;
    // The one corrective re-invocation fires, and the empty answer is a recorded failure, not a silent shipment.
    expect(attempts).toEqual([1, 2]);
    expect(candidate.imagePlan).toBeUndefined();
    expect(result.failures.some((failure) => failure.taskId === 'identity-art-director-modular-technical')).toBe(true);
  });

  it('reuses the image it already has when a token change reopens and the captain re-approves', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { stage } = harness({ raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    await stage.run();
    await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    await stage.imagerySettled();
    const first = stage.approvedImagery;
    expect(calls).toHaveLength(1);

    await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const again = await stage.approve({ directionId: 'modular-technical', rationale: 'Token revisado e aprovado.', approverRole: 'captain' });
    await stage.imagerySettled();
    // A token tweak is not a reshoot: the same prompt keeps the image it already
    // produced, so nothing is queued on the raster lane at all.
    expect(calls).toHaveLength(1);
    expect(again.assets).toEqual(first);
    expect(stage.handoff()!.assets.map((asset) => asset.provenance.hash)).toEqual(first.map((asset) => asset.provenance.hash));
  });

  it('asks again for an image the provider named no uri for, under the same digest', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let uri: string | undefined;
    const { stage, events } = harness({ raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { ...(uri ? { uri } : {}), license: 'provider terms 2026', termsNote: 'Owner review required.' }; } } } });
    await stage.run();
    // The MCP accepted the prompt and named no image, which is a recorded
    // failure the captain can see, never a placeholder that looks unfinished.
    await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    await stage.imagerySettled();
    const first = stage.approvedImagery;
    expect(first.map((asset) => asset.status)).toEqual(['failed']);
    expect(first[0]?.provenance.termsNote).toMatch(/no image/);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'identity.task.failed',
      payload: expect.objectContaining({ taskId: 'identity-imagery-modular-technical-texture-01', role: 'art-director', reason: expect.stringMatching(/no image/) }),
    }));

    uri = 'higgsfield://asset-1';
    await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    await stage.approve({ directionId: 'modular-technical', rationale: 'Token revisado e aprovado.', approverRole: 'captain' });
    await stage.imagerySettled();
    const again = stage.approvedImagery;
    // The unchanged digest is the idempotency key, so asking again costs nothing and picks up the finished image.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotency_key).toBe(calls[0]!.idempotency_key);
    expect(again.map((asset) => asset.status)).toEqual(['ready']);
    expect(again.map((asset) => asset.provenance.hash)).toEqual(first.map((asset) => asset.provenance.hash));
    expect(stage.handoff()!.assets.map((asset) => asset.uri)).toEqual(['higgsfield://asset-1']);
  });

  it('refuses a plan that smuggles photography or an unadmitted source into a direction that declared neither', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'typographic-low-chroma')!;
    const smuggled: ImagePromptPlan = {
      schemaVersion: 1,
      directionId: 'typographic-low-chroma',
      plans: [{ id: 'hero-01', role: 'portrait', prompt: 'Retrato documental do capitão em luz lateral rasante.', negatives: ['gradiente roxo-azul'], aspect: '3:2', axis: 'imagery', alt: 'Retrato.', licenceExpectation: 'Uso interno do proprietário.' }],
    };
    const violations = imageryPolicyViolations(smuggled, store.get(candidate.versionId)!.ir);
    expect(violations.some((violation) => /no-photography/.test(violation))).toBe(true);
    expect(violations.some((violation) => /allowed sources/.test(violation))).toBe(true);
  });

  it('shoots on the raster lane after the gate closes, and a cancellation lands on the asset', async () => {
    let reached: AbortSignal | undefined;
    let entered = (): void => {};
    const shooting = new Promise<void>((resolve) => { entered = resolve; });
    const transport = {
      callTool: async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        reached = signal;
        entered();
        // A server that accepts the prompt and never answers.
        return new Promise<{ uri?: string }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('the call was cancelled')), { once: true });
        });
      },
    };
    const { stage } = harness({ raster: { configured: true, transport } });
    await stage.run();
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });

    // The decision is recorded and returned before the lane has even started.
    expect(approval.assets.map((asset) => asset.status)).toEqual(['generating']);
    expect(stage.gateState().state).toBe('closed');
    await shooting;
    expect(reached!.aborted).toBe(false);

    await stage.cancelImagery();
    expect(reached!.aborted).toBe(true);
    const settled = stage.approvedImagery;
    expect(settled.map((asset) => asset.status)).toEqual(['failed']);
    expect(settled[0]?.provenance.termsNote).toMatch(/cancelled/);
    // The image is gone; the decision it was shot for is not.
    expect(settled[0]?.provenance.prompt).toBeTruthy();
    expect(settled[0]?.provenance.termsNote).toMatch(/Expected licence:/);
    expect(stage.gateState().state).toBe('closed');
    expect(stage.handoff()!.assets.map((asset) => asset.id)).toEqual(settled.map((asset) => asset.id));
  });

  it('gives the captain the gate back while an earlier batch is still shooting', async () => {
    const held: Array<() => void> = [];
    let entered = (): void => {};
    const shooting = new Promise<void>((resolve) => { entered = resolve; });
    const transport = {
      callTool: async () => {
        entered();
        return new Promise<{ uri?: string; license?: string; termsNote?: string }>((resolve) => {
          held.push(() => resolve({ uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'ok' }));
        });
      },
    };
    const { stage } = harness({ raster: { configured: true, transport } });
    await stage.run();
    await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    await shooting;

    // A token change reopens the gate while the first batch is still on the
    // lane. Re-approving must not wait for it: this call resolving at all is
    // the assertion, since the endpoint above never answers on its own.
    await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const again = await stage.approve({ directionId: 'modular-technical', rationale: 'Token revisado e aprovado.', approverRole: 'captain' });
    expect(again.assets.map((asset) => asset.status)).toEqual(['generating']);
    expect(held).toHaveLength(1);

    // The batch that was in flight settles first, and what it finished is not shot again.
    for (const release of held) release();
    await stage.imagerySettled();
    expect(held).toHaveLength(1);
    expect(stage.approvedImagery.map((asset) => asset.status)).toEqual(['ready']);
  });

  it('shoots nothing more once the captain cancels, even for a batch that had not reached the lane', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let entered = (): void => {};
    const shooting = new Promise<void>((resolve) => { entered = resolve; });
    const transport = {
      callTool: async (_name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        calls.push(args);
        entered();
        return new Promise<{ uri?: string }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('the call was cancelled')), { once: true });
        });
      },
    };
    const { stage } = harness({ raster: { configured: true, transport } });
    await stage.run();
    await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    await shooting;
    expect(calls).toHaveLength(1);

    // A re-approval parks behind the batch on the lane, so this second batch is
    // cancelled before it ever reaches the scheduler.
    await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    await stage.approve({ directionId: 'modular-technical', rationale: 'Token revisado e aprovado.', approverRole: 'captain' });
    await stage.cancelImagery();

    expect(calls).toHaveLength(1);
    expect(stage.approvedImagery.map((asset) => asset.status)).toEqual(['failed']);
  });

  it('records a lane that cannot even write its own events, instead of leaving a rejection loose', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { stage } = harness({
      raster: { configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'ok' }; } } },
      // The ledger stops accepting writes the moment the lane starts, which is
      // what a shutdown between the decision and the shot looks like.
      onEvent: (type, payload) => {
        if (type === 'identity.task.queued' && String(payload.taskId).startsWith('identity-imagery-')) throw new Error('the ledger is closed');
      },
    });
    await stage.run();
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'A direção modular responde ao briefing.', approverRole: 'captain' });
    expect(approval.assets.map((asset) => asset.status)).toEqual(['generating']);

    await stage.imagerySettled();
    // The decision stands, nothing was shot, and the image says what became of it.
    expect(calls).toEqual([]);
    expect(stage.gateState().state).toBe('closed');
    const settled = stage.approvedImagery;
    expect(settled.map((asset) => asset.status)).toEqual(['failed']);
    expect(settled[0]?.provenance.termsNote).toMatch(/the ledger is closed/);
    expect(stage.snapshot().failures.some((failure) => failure.taskId === 'identity-imagery-modular-technical')).toBe(true);
  });

  it('refuses to submit for a direction whose contract admits no generated source', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = new HiggsfieldMcpProvider({ configured: true, transport: { callTool: async (_name, args) => { calls.push(args); return { uri: 'higgsfield://asset-1', license: 'x', termsNote: 'y' }; } } });
    const plan: ImagePromptPlan = {
      schemaVersion: 1,
      directionId: 'typographic-low-chroma',
      plans: [{ id: 'texture-01', role: 'texture', prompt: 'Textura de papel impresso em duas tintas, luz rasante.', negatives: ['fotografia de banco'], aspect: '3:2', axis: 'materiality', alt: 'Textura.', licenceExpectation: 'Uso interno do proprietário.' }],
    };
    // The guard is at the site that performs the call, so no caller can get past it.
    await expect(generateImageAsset(plan, plan.plans[0]!, { provider, identityVersionId: 'v-test', identity: fakeIdentityFor('typographic-low-chroma') }))
      .rejects.toThrow(/admits the sources/);
    expect(calls).toEqual([]);
  });

  it('plans no image at all for a direction that admits no generated source', async () => {
    const plan: ImagePromptPlan = {
      schemaVersion: 1,
      directionId: 'typographic-low-chroma',
      plans: [{ id: 'texture-01', role: 'texture', prompt: 'Textura de papel impresso em duas tintas, luz rasante.', negatives: ['fotografia de banco'], aspect: '3:2', axis: 'materiality', alt: 'Textura.', licenceExpectation: 'Uso interno do proprietário.' }],
    };
    // Nothing is queued on the raster lane, so nothing can be submitted for it.
    expect(plannedImagery(plan, { identity: fakeIdentityFor('typographic-low-chroma') })).toEqual([]);
    expect(plannedImagery(plan, { identity: fakeIdentityFor('modular-technical') }).map((asset) => asset.status)).toEqual(['generating']);
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

  it('blocks a direction whose critic scored below the absolute rubric until the captain overrides in writing', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-critic-system-a11y-critic-editorial-material') return result;
        const report = result.artifact as Record<string, unknown>;
        // A sub-minimum score with no veto finding: the rubric is the only thing standing in the way.
        return { ...result, artifact: { ...report, scores: [{ dimension: 'system-accessibility', score: 2, evidence: 'O sistema de tipos não sustenta o mínimo de leitura.' }] } };
      },
    };
    const { stage } = harness({ provider });
    const result = await stage.run();
    const candidate = result.candidates.find((entry) => entry.directionId === 'editorial-material')!;
    expect(candidate.blocking).toEqual([]);
    expect(candidate.rubricGaps).toEqual([{ dimension: 'system-accessibility', score: 2, evidence: 'O sistema de tipos não sustenta o mínimo de leitura.' }]);
    expect(candidate.scores).toContainEqual({ criticId: 'system-a11y-critic', dimension: 'system-accessibility', score: 2 });

    await expect(stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain' })).rejects.toThrow(/below the absolute minimum of 3/);
    const approved = await stage.approve({ directionId: 'editorial-material', rationale: 'Gosto dessa.', approverRole: 'captain', overrideRationale: 'A nota é sobre uma rota que o Gate 2 vai refazer.' });
    expect(approved.record.overrideRationale).toBe('A nota é sobre uma rota que o Gate 2 vai refazer.');
    // The other two cards keep the rubric they passed, so the minimum blocks only where it failed.
    for (const other of result.candidates.filter((entry) => entry.directionId !== 'editorial-material')) expect(other.rubricGaps).toEqual([]);
  });

  it('hands the next stage a hash of the approved identity, not of the whole document', async () => {
    const { stage, store } = harness();
    const result = await stage.run();
    const chosen = result.candidates.find((candidate) => candidate.directionId === 'typographic-low-chroma')!;
    const approval = await stage.approve({ directionId: chosen.directionId, rationale: 'A direção tipográfica sustenta o argumento.', approverRole: 'captain' });
    const approved = store.get(approval.record.versionId)!;
    expect(approval.record.identityHash).toBe(identityHash(approved.ir));
    expect(approval.record.identityHash).not.toBe(identityHash(store.get(result.baseVersionId)!.ir));
    expect(stage.gateState().state).toBe('closed');
    // The comparison is over: the matrix retires, the record of what it beat stays.
    expect(approved.ir.identity.direction.divergence).toBeUndefined();
    expect(approved.ir.identity.direction.rejectedAlternatives.map((entry) => entry.directionId).sort()).toEqual(['editorial-material', 'modular-technical']);
    expect(approved.parentId).toBe(chosen.versionId);
  });

  it('reopens after a token change and names the renders the change made unreachable', async () => {
    const { stage, store, events } = harness();
    const result = await stage.run();
    const chosen = result.candidates.find((candidate) => candidate.directionId === 'modular-technical')!;
    await stage.approve({ directionId: chosen.directionId, rationale: 'Aprovada.', approverRole: 'captain' });
    const approvedIr = store.get(chosen.versionId)!.ir;

    const changed = await stage.changeToken({ tokenPath: 'color.accent', value: '#ff5c00', rationale: 'O capitão pediu um sinal mais quente.' });
    expect(changed.gate.state).toBe('reopened');
    if (changed.gate.state !== 'reopened') throw new Error('unreachable');
    expect(changed.gate.impact.changedTokenPaths).toEqual(['color.accent']);
    expect(changed.gate.impact.staleRenderKeys.length).toBeGreaterThan(0);

    const currentIr = store.get(changed.versionId)!.ir;
    const impact = identityChangeImpact(approvedIr, currentIr, chosen.versionId);
    expect(impact.reopensGate).toBe(true);
    // Every render key the approved identity produced is gone; none survives into the new version.
    const nextKeys = new Set(identityChangeImpact(currentIr, approvedIr, chosen.versionId).staleRenderKeys);
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
    expect(identityChangeImpact(ir, withNewPageTitle, chosen.versionId).reopensGate).toBe(false);
    expect(stage.gateState().state).toBe('closed');
  });

  it('refuses a second decision while the gate is closed, and accepts one after it reopens', async () => {
    const { stage, store } = harness();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Mudei de ideia.', approverRole: 'captain' })).rejects.toThrow(/already closed/);

    const changed = await stage.changeToken({ tokenPath: 'color.muted', value: '#5b6b62', rationale: 'Anotação mais legível.' });
    await expect(stage.approve({ directionId: 'modular-technical', rationale: 'Outra direção.', approverRole: 'captain' })).rejects.toThrow(/cannot be approved onto that lineage/);

    const reapproved = await stage.approve({ directionId: 'editorial-material', rationale: 'Novo token revisado e aprovado.', approverRole: 'captain' });
    expect(stage.gateState().state).toBe('closed');
    expect(reapproved.record.identityHash).toBe(identityHash(store.get(changed.versionId)!.ir));
    expect(stage.handoff()?.stale).toBe(false);
  });

  it('refuses to change a token the approved identity does not define', async () => {
    const { stage } = harness();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.changeToken({ tokenPath: 'color.ghost', value: '#000000', rationale: 'x' })).rejects.toThrow(/is not defined/);
  });

  it('keeps the approved token type and refuses a value that type cannot take', async () => {
    const { stage, store } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.changeToken({ tokenPath: 'space.md', value: '#ff7a00', rationale: 'x' })).rejects.toThrow(/dimension token expects/);

    const changed = await stage.changeToken({ tokenPath: 'space.md', value: '2rem', rationale: 'Ritmo mais largo.' });
    const before = flattenTokens(store.get(approval.versionId)!.ir.identity.tokens).get('space.md')!;
    const after = flattenTokens(store.get(changed.versionId)!.ir.identity.tokens).get('space.md')!;
    expect(after).toEqual({ ...before, $value: '2rem' });
    expect(after.$type).toBe('dimension');
  });

  it('refuses a token value that would not close its own CSS declaration', async () => {
    const { stage, store } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    const accentBefore = flattenTokens(store.get(approval.versionId)!.ir.identity.tokens).get('color.accent');
    const bodyBefore = flattenTokens(store.get(approval.versionId)!.ir.identity.tokens).get('type.body');
    for (const [tokenPath, value] of [['color.accent', '#ff7a0'], ['color.accent', 'rgb(255 0 0'], ['type.body', '"Inter, Arial, sans-serif'], ['type.body', 'var(--x']] as const) {
      await expect(stage.changeToken({ tokenPath, value, rationale: 'Colado pela metade.' })).rejects.toThrow();
      const tokens = flattenTokens(store.get(stage.approvedVersionId!)!.ir.identity.tokens);
      expect([tokens.get('color.accent'), tokens.get('type.body')]).toEqual([accentBefore, bodyBefore]);
    }

    for (const [tokenPath, value] of [['color.accent', '#ff7a00'], ['color.accent', 'rgb(255 122 0)'], ['color.accent', 'oklch(0.72 0.18 45)'], ['type.body', '"O\'Neil Sans", Inter, sans-serif']] as const) {
      const changed = await stage.changeToken({ tokenPath, value, rationale: 'Ajuste do capitão.' });
      expect(flattenTokens(store.get(changed.versionId)!.ir.identity.tokens).get(tokenPath)?.$value).toBe(value);
    }
  });

  it('commits nothing for a refused change, so the same token stays changeable', async () => {
    const { stage } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.changeToken({ tokenPath: 'color.accent', value: '{color.accent}', rationale: 'Alias circular por engano.' })).rejects.toThrow();
    expect(stage.gateState().state).toBe('closed');
    // The refused change reserved nothing in the branch's patch gate.
    const changed = await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Valor correto.' });
    expect(changed.gate.state).toBe('reopened');
    expect(changed.versionId).not.toBe(approval.versionId);
  });

  it('keeps a token path changeable after the captain undoes a change on it', async () => {
    const { stage, store } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'modular-technical', rationale: 'Aprovada.', approverRole: 'captain' });
    const before = flattenTokens(store.get(approval.versionId)!.ir.identity.tokens).get('color.accent')!.$value;

    const changed = await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    expect(changed.gate.state).toBe('reopened');
    // Restoring the approved value is a new version carrying the approved identity again.
    const undone = await stage.changeToken({ tokenPath: 'color.accent', value: before, rationale: 'Volta ao sinal aprovado.' });
    expect(undone.versionId).not.toBe(approval.versionId);
    expect(identityHash(store.get(undone.versionId)!.ir)).toBe(identityHash(store.get(approval.versionId)!.ir));
    expect(undone.gate.state).toBe('closed');

    // The same path takes a third change: the undo claimed nothing that outlives it.
    const again = await stage.changeToken({ tokenPath: 'color.accent', value: '#00a37a', rationale: 'Outro sinal.' });
    expect(again.gate.state).toBe('reopened');
    expect(flattenTokens(store.get(again.versionId)!.ir.identity.tokens).get('color.accent')!.$value).toBe('#00a37a');
  });

  it('keeps a token path changeable after a change that repeats the value it already has', async () => {
    const { stage, store } = harness();
    await stage.run();
    await stage.approve({ directionId: 'modular-technical', rationale: 'Aprovada.', approverRole: 'captain' });
    const changed = await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const repeated = await stage.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Clique repetido.' });
    expect(identityHash(store.get(repeated.versionId)!.ir)).toBe(identityHash(store.get(changed.versionId)!.ir));

    const again = await stage.changeToken({ tokenPath: 'color.accent', value: '#00a37a', rationale: 'Outro sinal.' });
    expect(flattenTokens(store.get(again.versionId)!.ir.identity.tokens).get('color.accent')!.$value).toBe('#00a37a');
  });

  it('refuses to replace a whole token group with a single token', async () => {
    const { stage, store } = harness();
    await stage.run();
    const approval = await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    await expect(stage.changeToken({ tokenPath: 'motion', value: '1ms', rationale: 'x' })).rejects.toThrow(/is not defined/);
    expect(store.get(approval.versionId)!.ir.identity.tokens.motion).toEqual({ quick: { $value: '220ms', $type: 'duration' } });
    expect(stage.gateState().state).toBe('closed');
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

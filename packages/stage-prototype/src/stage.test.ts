import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask, type IdentitySpec } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { renderDesign } from '@pwb/renderer';
import {
  DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, PrototypeStageError, createOffRhythmControlIR, criticRegistry,
  type ComposerProvider, type CritiqueProvider, type CritiqueReport, type CritiqueTask, type ProposedPatch,
  type PrototypeStageOutcome, type RouteManifest, type SectionComposition, type SectionPlan,
} from './index.js';

interface Harness { store: VersionStore; applier: Applier; base: VersionRecord; events: Array<{ type: string; payload: Record<string, unknown> }>; }

function harness(): Harness {
  const store = new VersionStore();
  const applier = new Applier(store, new PatchGate());
  const base = applier.createRoot(createFixtureIR());
  return { store, applier, base, events: [] };
}

function stageFor(setup: Harness, composer: ComposerProvider = new FakeSectionComposer(), critique: CritiqueProvider = new FakeCritiqueProvider()): PrototypeStage {
  return new PrototypeStage({
    store: setup.store,
    applier: setup.applier,
    scheduler: new Scheduler({ maxActiveClaude: 3 }),
    architect: new FakeInformationArchitect(),
    composer,
    critique,
    evidence: new DerivedEvidenceSource(),
    brief: 'Compilar a identidade aprovada em um protótipo de três rotas.',
    onEvent: (type, payload) => { setup.events.push({ type, payload }); },
  });
}

/** A critic under the test's control, so a loop that would never settle on its own can be observed. */
class ScriptedCritic implements CritiqueProvider {
  private cycles = 0;
  constructor(private readonly script: (cycle: number) => { patch?: ProposedPatch; score: number } | undefined) {}

  async critique(task: CritiqueTask): Promise<CritiqueReport> {
    if (task.dimension === criticRegistry[0]!.dimension) this.cycles += 1;
    const cycle = Math.max(1, this.cycles);
    const entry = task.dimension === 'coherence' ? this.script(cycle) : undefined;
    const findings = entry ? [{
      id: `scripted-c${cycle}`, dimension: 'coherence' as const, severity: 'major' as const,
      evidence: { route: '/', viewport: 390, state: 'default', colorScheme: 'light' as const, reducedMotion: false, nodeIds: ['home-hero-root'] },
      observation: 'Observação roteirizada.', why: 'Contradiz o contrato aprovado.', confidence: 0.9,
      ...(entry.patch ? { patch: entry.patch } : {}), checks: [], abstain: false,
    }] : [];
    return {
      schemaVersion: '1', stage: 'prototype', dimension: task.dimension, criticSessionId: task.criticSessionId,
      perception: { summary: 'Leitura roteirizada.', regions: [] },
      comprehension: { hierarchy: 'h', intent: 'i', brandAlignment: 'b' },
      projection: {
        verdict: findings.length > 0 ? 'revise' : 'pass',
        rubric: criticRegistry.find((critic) => critic.dimension === task.dimension)!.rubric.map((criterion) => ({ criterion: criterion.criterion, score: entry ? entry.score : 4, evidence: 'roteiro do teste' })),
        findings,
      },
    };
  }
}

/** A composer that leaves one section root off the declared grid rhythm, the way a real one can. */
class DriftingComposer implements ComposerProvider {
  private readonly inner = new FakeSectionComposer();
  constructor(private readonly sectionId: string) {}
  async compose(task: AgentTask, section: SectionPlan, manifest: RouteManifest, signal?: AbortSignal): Promise<SectionComposition> {
    const composition = await this.inner.compose(task, section, manifest, signal);
    if (section.id !== this.sectionId) return composition;
    const [root, ...rest] = composition.nodes;
    return { ...composition, nodes: [{ ...root!, props: { ...root!.props, gap: '{space.sm}' } }, ...rest] };
  }
}

describe('prototype stage', () => {
  it('takes a three-route prototype through Tier 0 without a veto and stops for a stated reason', async () => {
    const setup = harness();
    const outcome = await stageFor(setup).run({ runId: 'run-prototype', baseVersionId: setup.base.id });

    expect(outcome.manifest.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
    expect(outcome.qa.vetoes).toEqual([]);
    expect(outcome.gate).toBe('needs_review');
    expect(outcome.lint.errorCount).toBe(0);
    expect(outcome.stopReason).toBe('clean');
    expect(outcome.reports.map((report) => report.dimension).sort()).toEqual(['a11y-interaction', 'coherence', 'narrative', 'responsiveness']);
    expect(outcome.reports.every((report) => report.projection.verdict === 'pass')).toBe(true);
    expect(outcome.cycles).toHaveLength(1);
  });

  it('writes every version through the applier and keeps the base revision for the A/B gate', async () => {
    const setup = harness();
    const outcome = await stageFor(setup).run({ runId: 'run-versions', baseVersionId: setup.base.id });

    expect(outcome.baseVersionId).toBe(setup.base.id);
    expect(new Set([outcome.baseVersionId, outcome.architectVersionId, outcome.compositionVersionId]).size).toBe(3);
    expect(setup.store.get(outcome.architectVersionId)?.parentId).toBe(outcome.baseVersionId);
    expect(setup.store.get(outcome.compositionVersionId)?.parentId).toBe(outcome.architectVersionId);
    expect(setup.store.get(outcome.versionId)?.ir.identity).toEqual(setup.base.ir.identity);
  });

  it('composes sections in parallel over disjoint windows and renders every route from tokens alone', async () => {
    const setup = harness();
    const outcome = await stageFor(setup).run({ runId: 'run-compose', baseVersionId: setup.base.id });
    const ir = setup.store.get(outcome.versionId)!.ir;

    const windows = outcome.manifest.routes.flatMap((route) => route.sections.map((section) => `${route.route}:${section.nodeRange.start}-${section.nodeRange.start + section.nodeRange.count - 1}`));
    expect(new Set(windows).size).toBe(windows.length);
    for (const page of ir.pages.routes) expect(page.nodes.every((node) => node.props.text !== 'Aguardando composição.')).toBe(true);

    const rendered = renderDesign(ir);
    expect(rendered.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
    // This renderer emits no anchors, so the journey has to survive in the copy the composer wrote.
    expect(rendered.routes[0]!.html).toContain('/proof');
    expect(rendered.routes[0]!.html).toMatch(/<h1 data-node-id="home-hero-title"/);
    expect(rendered.routes[0]!.html).not.toMatch(/style="[^"]*#[0-9a-f]{3,8}/i);
    // Every responsive rule the composer declared is read back out as a container query.
    expect(rendered.css).toContain('@container (min-width: 6rem)');
    expect(rendered.css).toContain('[data-node-id="home-hero-root"] { padding-inline: var(--space-md); }');
  });

  it('declares the loading, empty, error, focus and reduced-motion states the capture matrix needs', async () => {
    const setup = harness();
    const outcome = await stageFor(setup).run({ runId: 'run-states', baseVersionId: setup.base.id });
    const states = setup.store.get(outcome.versionId)!.ir.stateFixtures;

    expect(Object.keys(states).sort()).toEqual(['default', 'empty', 'error', 'focus', 'loading', 'reduced']);
    expect(states.reduced!.values.motion).toBe('reduced');
    expect(states.focus!.values.focus).toBe('home-hero-cta');
    expect(String(states.error!.values.hidden)).toContain('home-loading');
    expect(String(states.error!.values.hidden)).not.toContain('home-error');
  });

  it('turns a critic finding into a patch the gate applies, then stops once the problem is gone', async () => {
    const setup = harness();
    const outcome = await stageFor(setup, new DriftingComposer('home-hero')).run({ runId: 'run-refine', baseVersionId: setup.base.id });

    expect(outcome.cycles).toHaveLength(2);
    const [first, second] = outcome.cycles;
    expect(first!.appliedFindingIds).toHaveLength(1);
    expect(first!.appliedFindingIds[0]).toContain('coherence-QA1-RHYTHM');
    expect(first!.verdicts).toContain('revise');
    expect(second!.appliedFindingIds).toEqual([]);
    expect(outcome.stopReason).toBe('clean');
    expect(outcome.versionId).not.toBe(outcome.compositionVersionId);

    const repaired = setup.store.get(outcome.versionId)!.ir;
    const hero = repaired.pages.routes[0]!.nodes.find((node) => node.id === 'home-hero-root');
    expect(hero?.props.gap).toBe(repaired.identity.gridGrammar.rhythmToken);
    expect(setup.events.map((event) => event.type)).toContain('prototype.refine.applied');
  });

  it('refuses a composition that writes outside the window its section was given', async () => {
    const setup = harness();
    const trespasser: ComposerProvider = {
      compose: async (task, section, manifest, signal) => {
        const composition = await new FakeSectionComposer().compose(task, section, manifest, signal);
        if (section.id !== 'home-proof') return composition;
        const [root, ...rest] = composition.nodes;
        return { ...composition, nodes: [{ ...root!, slots: { children: [...(root!.slots.children ?? []), 'home-hero-title'] } }, ...rest] };
      },
    };
    await expect(stageFor(setup, trespasser).run({ runId: 'run-trespass', baseVersionId: setup.base.id }))
      .rejects.toThrow(/home-hero-title, which belongs to another section/);
  });

  it('refuses a composition that leaves the token system', async () => {
    const setup = harness();
    const raw: ComposerProvider = {
      compose: async (task, section, manifest, signal) => {
        const composition = await new FakeSectionComposer().compose(task, section, manifest, signal);
        const [root, ...rest] = composition.nodes;
        return { ...composition, nodes: [{ ...root!, props: { ...root!.props, background: '#101010' } }, ...rest] };
      },
    };
    await expect(stageFor(setup, raw).run({ runId: 'run-raw', baseVersionId: setup.base.id }))
      .rejects.toThrow(PrototypeStageError);
  });

  it('stops at the cycle ceiling instead of iterating while the rubric keeps climbing', async () => {
    const props: ProposedPatch[] = [
      { operation: 'set_token', nodeId: 'home-hero-root', prop: 'padding', token: '{space.lg}' },
      { operation: 'set_token', nodeId: 'home-hero-root', prop: 'radius', token: '{radius.card}' },
      { operation: 'set_token', nodeId: 'home-hero-root', prop: 'maxWidth', token: '{space.xl}' },
    ];
    const setup = harness();
    const critic = new ScriptedCritic((cycle) => cycle <= 3 ? { patch: props[cycle - 1]!, score: (cycle - 1) * 2 } : undefined);
    const outcome = await stageFor(setup, new FakeSectionComposer(), critic).run({ runId: 'run-ceiling', baseVersionId: setup.base.id });

    expect(outcome.cycles).toHaveLength(3);
    expect(outcome.cycles.every((entry) => entry.appliedFindingIds.length === 1)).toBe(true);
    expect(outcome.stopReason).toBe('max_cycles');
    expect(outcome.gate).toBe('needs_review');
  });

  it('stops when the same problem survives a repair instead of proposing it again forever', async () => {
    const setup = harness();
    const repeated: ProposedPatch = { operation: 'set_token', nodeId: 'home-hero-root', prop: 'padding', token: '{space.lg}' };
    const outcome = await stageFor(setup, new FakeSectionComposer(), new ScriptedCritic(() => ({ patch: repeated, score: 2 })))
      .run({ runId: 'run-repeat', baseVersionId: setup.base.id });

    expect(outcome.cycles).toHaveLength(2);
    expect(outcome.cycles[1]!.appliedFindingIds).toEqual([]);
    expect(outcome.stopReason).toBe('repeated_issue');
  });

  it('stops on the first round when no finding carries a repair the planner can apply', async () => {
    const setup = harness();
    const ghost: ProposedPatch = { operation: 'set_token', nodeId: 'not-a-node', prop: 'gap', token: '{space.md}' };
    const outcome = await stageFor(setup, new FakeSectionComposer(), new ScriptedCritic(() => ({ patch: ghost, score: 2 })))
      .run({ runId: 'run-unapplicable', baseVersionId: setup.base.id });

    expect(outcome.cycles).toHaveLength(1);
    expect(outcome.stopReason).toBe('no_actionable_patch');
    expect(outcome.rejectedRepairs.map((entry) => entry.reason).join(' ')).toContain('não tem o nó not-a-node');
    expect(outcome.versionId).toBe(outcome.compositionVersionId);
  });

  it('escalates to the gate when a critic cannot produce a typed report', async () => {
    const setup = harness();
    const broken: CritiqueProvider = { critique: async (task) => { throw new Error(`o crítico ${task.dimension} falhou`); } };
    const outcome = await stageFor(setup, new FakeSectionComposer(), broken).run({ runId: 'run-uncertain', baseVersionId: setup.base.id });

    expect(outcome.stopReason).toBe('uncertain');
    expect(outcome.reports.every((report) => report.projection.verdict === 'uncertain')).toBe(true);
    expect(setup.events.map((event) => event.type)).toContain('prototype.critic.unavailable');
    expect(outcome.gate).toBe('needs_review');
  });

  it('never lets the stage touch the approved identity', async () => {
    const setup = harness();
    const outcome: PrototypeStageOutcome = await stageFor(setup).run({ runId: 'run-identity', baseVersionId: setup.base.id });
    const before = setup.base.ir.identity as IdentitySpec;
    for (const versionId of [outcome.architectVersionId, outcome.compositionVersionId, outcome.versionId]) {
      expect(setup.store.get(versionId)!.ir.identity).toEqual(before);
    }
  });
});

describe('control seed', () => {
  it('reports a known defect, so a clean run is not the only thing the loop was ever shown', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot(createOffRhythmControlIR());
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const stage = new PrototypeStage({
      store, applier, scheduler: new Scheduler({ maxActiveClaude: 3 }),
      architect: new FakeInformationArchitect(), composer: new FakeSectionComposer(),
      critique: new FakeCritiqueProvider(), evidence: new DerivedEvidenceSource(),
      brief: 'Par de controle com ritmo impossível.',
      onEvent: (type, payload) => { events.push({ type, payload }); },
    });
    const outcome = await stage.run({ runId: 'run-control', baseVersionId: base.id });

    expect(outcome.qa.vetoes).toEqual([]);
    expect(outcome.reports.flatMap((report) => report.projection.findings).length).toBeGreaterThan(0);
    const coherence = outcome.reports.find((report) => report.dimension === 'coherence')!;
    expect(coherence.projection.verdict).toBe('revise');
    expect(coherence.projection.findings.every((finding) => finding.patch?.operation === 'set_token')).toBe(true);
    expect(new Set(coherence.projection.findings.map((finding) => finding.patch && 'prop' in finding.patch ? finding.patch.prop : ''))).not.toEqual(new Set(['gap']));
    expect(outcome.cycles[0]!.appliedFindingIds.length).toBeGreaterThan(0);
    expect(outcome.cycles.length).toBeLessThanOrEqual(3);
    expect(['max_cycles', 'repeated_issue', 'improvement_below_noise', 'clean', 'no_actionable_patch']).toContain(outcome.stopReason);
    expect(events.map((event) => event.type)).toContain('prototype.cycle.decided');
  });
});

import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask, type DesignIR, type IdentitySpec } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore, type ScheduleResult, type VersionRecord } from '@pwb/orchestrator';
import { CodexCliError } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import {
  ClaudeCritiqueRunner, CodexSession, DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, PrototypeStageError, criticRegistry,
  type ComposerProvider, type CritiqueProvider, type CritiqueReport, type CritiqueTask, type EvidenceSource, type ProposedPatch,
  type PrototypeStageOutcome, type RouteManifest, type SectionComposition, type SectionPlan,
} from './index.js';

/**
 * A revision with a known defect, so the loop is never only shown clean input: the grid grammar declares
 * a beat the identity's own spacing roles cannot land on, and every section inherits spacing off it.
 * It lives here because it is a test fixture; this prototype-stage fixture runs
 * one fixed briefing and one mode, while Gate 1 supplies a briefing per run.
 */
function createOffRhythmControlIR(): DesignIR {
  const ir = createFixtureIR();
  const space = ir.identity.tokens.space as Record<string, { $value: string; $type: 'dimension' }>;
  ir.identity.tokens = { ...ir.identity.tokens, space: { ...space, beat: { $value: '0.625rem', $type: 'dimension' } } };
  ir.identity.gridGrammar = { ...ir.identity.gridGrammar, rhythmToken: '{space.beat}' };
  return ir;
}

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
    // The outcome reports the widths the evidence really carried, so the review cannot claim another.
    expect(outcome.measuredViewports).toEqual([390, 768, 1440]);
  });

  it('reports only the widths its evidence source measured', async () => {
    const setup = harness();
    const narrow: EvidenceSource = {
      collect: async (request) => {
        const bundle = await new DerivedEvidenceSource().collect(request);
        return { evidence: bundle.evidence.filter((entry) => entry.context.viewport === 768), captures: bundle.captures };
      },
    };
    const stage = new PrototypeStage({
      store: setup.store, applier: setup.applier, scheduler: new Scheduler({ maxActiveClaude: 3 }),
      architect: new FakeInformationArchitect(), composer: new FakeSectionComposer(),
      critique: new FakeCritiqueProvider(), evidence: narrow,
      brief: 'Uma largura só.',
    });
    const outcome = await stage.run({ runId: 'run-narrow', baseVersionId: setup.base.id });
    expect(outcome.measuredViewports).toEqual([768]);
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
    // The call to action is a real anchor, so the journey is carried by a link the keyboard can reach.
    expect(rendered.routes[0]!.html).toContain('/proof');
    expect(rendered.routes[0]!.html).toMatch(/<h1 data-node-id="home-hero-title"/);
    // Every composed value reaches the page through a token: the node rules name custom properties,
    // and the only literal colours in the stylesheet are the ones :root defines them as.
    const components = rendered.css.slice(rendered.css.indexOf('@layer components'));
    expect(components).toMatch(/\[data-node-id="home-hero-root"\]/);
    expect(components).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rendered.css.slice(0, rendered.css.indexOf('@layer components'))).toMatch(/#[0-9a-f]{6}\b/i);
    // Every responsive rule the composer declared is read back out as a container query.
    // The composer opens its breakpoints at the identity's own container widths, so a query really
    // separates a phone from a desktop instead of matching at every viewport.
    expect(rendered.css).toContain('@container (min-width: 44rem)');
    expect(rendered.css).toContain('@container (min-width: 60rem)');
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

  it('pairs each composer result with its own section even when the composers finish out of order', async () => {
    const setup = harness();
    // A real ClaudeSectionComposer finishes when its subprocess does, so the scheduler reports the
    // sections in completion order; the last section to be queued answers first here.
    const order: string[] = [];
    const reversed: ComposerProvider = {
      compose: async (task, section, manifest, signal) => {
        const composition = await new FakeSectionComposer().compose(task, section, manifest, signal);
        const delay = section.id === 'home-hero' ? 30 : section.id === 'home-proof' ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(section.id);
        return composition;
      },
    };
    const outcome = await stageFor(setup, reversed).run({ runId: 'run-order', baseVersionId: setup.base.id });

    expect(order.indexOf('home-hero')).toBeGreaterThan(order.indexOf('home-proof'));
    const ir = setup.store.get(outcome.compositionVersionId)!.ir;
    for (const route of outcome.manifest.routes) {
      const page = ir.pages.routes.find((candidate) => candidate.route === route.route)!;
      for (const section of route.sections) {
        expect(page.nodes.slice(section.nodeRange.start, section.nodeRange.start + section.nodeRange.count).map((node) => node.id)).toEqual(section.nodeIds);
      }
    }
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

  it('refuses a responsive rule whose props leave the token system, before the renderer sees it', async () => {
    const setup = harness();
    const rawBreakpoint: ComposerProvider = {
      compose: async (task, section, manifest, signal) => {
        const composition = await new FakeSectionComposer().compose(task, section, manifest, signal);
        const [root, ...rest] = composition.nodes;
        const [rule, ...others] = root!.responsive;
        return { ...composition, nodes: [{ ...root!, responsive: [{ ...rule!, props: { gap: '1rem' } }, ...others] }, ...rest] };
      },
    };
    await expect(stageFor(setup, rawBreakpoint).run({ runId: 'run-raw-responsive', baseVersionId: setup.base.id }))
      .rejects.toThrow(/responsive .* gap outside the token system/);
  });

  it('refuses a composition that answers a section other than the one its task named', async () => {
    const setup = harness();
    const confused: ComposerProvider = {
      compose: async (task, section, manifest, signal) => {
        const composition = await new FakeSectionComposer().compose(task, section, manifest, signal);
        return section.id === 'home-hero' ? { ...composition, sectionId: 'home-proof' } : composition;
      },
    };
    await expect(stageFor(setup, confused).run({ runId: 'run-wrong-section', baseVersionId: setup.base.id }))
      .rejects.toThrow(/answers section home-hero; it declared home-proof/);
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

  it('keeps Codex setup guidance in the unavailable critic event', async () => {
    const setup = harness();
    const critique = new ClaudeCritiqueRunner({
      session: new CodexSession({
        runner: { run: async () => { throw new CodexCliError('CODEX_AUTH_REQUIRED', 'Codex CLI is not authenticated. Run `codex login`.'); } },
      }),
    });
    await stageFor(setup, new FakeSectionComposer(), critique).run({ runId: 'run-codex-auth', baseVersionId: setup.base.id });
    const event = setup.events.find((entry) => entry.type === 'prototype.critic.unavailable');
    expect(event?.payload.reason).toMatch(/CODEX_AUTH_REQUIRED.*codex login/i);
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

describe('prototype stage model alias', () => {
  /** Records what the stage asked the scheduler to run, so every task site is observed, not assumed. */
  class RecordingScheduler extends Scheduler {
    readonly seen: AgentTask[] = [];
    override async run<T>(tasks: AgentTask[], worker: (task: AgentTask, signal: AbortSignal) => Promise<T>, options: Parameters<Scheduler['run']>[2] = {}): Promise<ScheduleResult<T>> {
      this.seen.push(...tasks);
      return super.run(tasks, worker, options);
    }
  }

  it('names the resolved provider on the architect, composer and critic tasks', async () => {
    const setup = harness();
    const scheduler = new RecordingScheduler({ maxActiveClaude: 3 });
    const stage = new PrototypeStage({
      store: setup.store, applier: setup.applier, scheduler,
      architect: new FakeInformationArchitect(), composer: new FakeSectionComposer(),
      critique: new FakeCritiqueProvider(), evidence: new DerivedEvidenceSource(),
      brief: 'Compilar a identidade aprovada em um protótipo de três rotas.',
      modelAlias: 'codex-gpt-5.6-sol',
    });
    await stage.run({ runId: 'run-alias', baseVersionId: setup.base.id });
    const ids = scheduler.seen.map((task) => task.id);
    expect(ids.some((id) => id.endsWith('-architect'))).toBe(true);
    expect(ids.some((id) => id.includes('-compose-'))).toBe(true);
    expect(ids.some((id) => id.includes('-critic-'))).toBe(true);
    // Not one task may claim Claude produced it while Codex answered.
    expect([...new Set(scheduler.seen.map((task) => task.modelAlias))]).toEqual(['codex-gpt-5.6-sol']);
  });

  it('still names Claude when no provider is given, as the default it always was', async () => {
    const setup = harness();
    const scheduler = new RecordingScheduler({ maxActiveClaude: 3 });
    const stage = new PrototypeStage({
      store: setup.store, applier: setup.applier, scheduler,
      architect: new FakeInformationArchitect(), composer: new FakeSectionComposer(),
      critique: new FakeCritiqueProvider(), evidence: new DerivedEvidenceSource(),
      brief: 'Compilar a identidade aprovada em um protótipo de três rotas.',
    });
    await stage.run({ runId: 'run-alias-default', baseVersionId: setup.base.id });
    expect([...new Set(scheduler.seen.map((task) => task.modelAlias))]).toEqual(['claude-local']);
  });
});


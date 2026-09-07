import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask, type IdentitySpec } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { renderDesign } from '@pwb/renderer';
import {
  DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, PrototypeStageError, type ComposerProvider, type PrototypeStageOutcome, type RouteManifest, type SectionComposition, type SectionPlan,
} from './index.js';

interface Harness { store: VersionStore; applier: Applier; base: VersionRecord; events: Array<{ type: string; payload: Record<string, unknown> }>; }

function harness(): Harness {
  const store = new VersionStore();
  const applier = new Applier(store, new PatchGate());
  const base = applier.createRoot(createFixtureIR());
  return { store, applier, base, events: [] };
}

function stageFor(setup: Harness, composer: ComposerProvider = new FakeSectionComposer()): PrototypeStage {
  return new PrototypeStage({
    store: setup.store,
    applier: setup.applier,
    scheduler: new Scheduler({ maxActiveClaude: 3 }),
    architect: new FakeInformationArchitect(),
    composer,
    critique: new FakeCritiqueProvider(),
    evidence: new DerivedEvidenceSource(),
    brief: 'Compilar a identidade aprovada em um protótipo de três rotas.',
    onEvent: (type, payload) => { setup.events.push({ type, payload }); },
  });
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
    expect(rendered.routes[0]!.html).toContain('<a href="/proof"');
    expect(rendered.routes[0]!.html).not.toMatch(/style="[^"]*#[0-9a-f]{3,8}/i);
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

  it('never lets the stage touch the approved identity', async () => {
    const setup = harness();
    const outcome: PrototypeStageOutcome = await stageFor(setup).run({ runId: 'run-identity', baseVersionId: setup.base.id });
    const before = setup.base.ir.identity as IdentitySpec;
    for (const versionId of [outcome.architectVersionId, outcome.compositionVersionId, outcome.versionId]) {
      expect(setup.store.get(versionId)!.ir.identity).toEqual(before);
    }
  });
});

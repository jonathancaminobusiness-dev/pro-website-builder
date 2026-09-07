import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR } from '@pwb/domain';
import { Applier, PatchGate, VersionStore } from '@pwb/orchestrator';
import { planPatch, PrototypeRefiner, type Finding, type ProposedPatch } from './index.js';

const evidence = { route: '/', viewport: 390, state: 'default', colorScheme: 'light' as const, reducedMotion: false, nodeIds: ['home-title'] };

function finding(patch: ProposedPatch | undefined, overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'f1', dimension: 'coherence', severity: 'major', evidence,
    observation: 'observado', why: 'contradiz o contrato', confidence: 0.9,
    ...(patch ? { patch } : {}), checks: [], abstain: false, ...overrides,
  };
}

function plan(findings: Finding[], ir: DesignIR = createFixtureIR(), allowedPaths = ['/pages', '/assets']) {
  return planPatch({ ir, findings, allowedPaths, baseVersionId: 'v0', idempotencyKey: 'key-1' });
}

describe('patch planner', () => {
  it('compiles each allowlisted repair into a guarded write on the node it names', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.responsive = [];
    ir.assets.items[0] = { ...ir.assets.items[0]!, kind: 'raster' };
    const repairs: ProposedPatch[] = [
      { operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' },
      { operation: 'replace_copy', nodeId: 'home-proof', text: 'Processo rastreável em cada etapa.' },
      { operation: 'reorder_node', nodeId: 'home-root', slot: 'children', order: ['home-proof', 'home-title'] },
    ];
    const result = plan(repairs.map((patch, index) => finding(patch, { id: `f${index}` })));
    expect(result.rejected).toEqual([]);
    expect(result.patch!.touchedPaths).toEqual([
      '/pages/routes/0/nodes/1/props/gap',
      '/pages/routes/0/nodes/2/props/text',
      '/pages/routes/0/nodes/0/slots/children',
    ]);
    expect(result.patch!.operations.filter((operation) => operation.op === 'test')).toHaveLength(3);
    expect(result.patch!.operations[0]).toEqual({ op: 'test', path: '/pages/routes/0/nodes/1/props/gap' });
    expect(result.patch!.stage).toBe('prototype');
    expect(result.patch!.idempotencyKey).toBe('key-1');
  });

  it('writes a crop only onto a raster asset that exists', () => {
    const ir = createFixtureIR();
    const crop: ProposedPatch = { operation: 'set_crop', assetId: 'fixture-mark', focalX: 0.3, focalY: 0.7, aspect: '3:2' };
    expect(plan([finding(crop)], ir).rejected[0]!.reason).toContain('Só um asset raster pode ser recortado');
    ir.assets.items[0] = { ...ir.assets.items[0]!, kind: 'raster' };
    const result = plan([finding(crop)], ir);
    expect(result.patch!.operations).toEqual([
      { op: 'test', path: '/assets/items/0/crop' },
      { op: 'add', path: '/assets/items/0/crop', value: { focalX: 0.3, focalY: 0.7, aspect: '3:2' } },
    ]);
    expect(plan([finding({ ...crop, assetId: 'ghost' })], ir).rejected[0]!.reason).toContain('não tem o asset ghost');
  });

  it('refuses a repair that leaves the allowlist, the token system or the identity vocabulary', () => {
    const reasons = (result: ReturnType<typeof plan>): string => result.rejected.map((entry) => entry.reason).join(' ');
    expect(reasons(plan([finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.nope}' })]))).toContain('não define o token');
    expect(reasons(plan([finding({ operation: 'set_token', nodeId: 'ghost', prop: 'gap', token: '{space.md}' })]))).toContain('não tem o nó ghost');
    expect(reasons(plan([finding({ operation: 'replace_copy', nodeId: 'home-title', text: 'Uma promessa revolucionário.' })]))).toContain('que a identidade proíbe');
    expect(reasons(plan([finding({ operation: 'set_constraint', nodeId: 'home-title', container: 'wide', rule: 'x' })]))).toContain('não declara o container wide');
    expect(reasons(plan([finding({ operation: 'reorder_node', nodeId: 'home-root', slot: 'children', order: ['home-title', 'ghost'] })]))).toContain('manter exatamente os filhos');
    expect(reasons(plan([finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' })], createFixtureIR(), ['/reviewRecord']))).toContain('fora dos caminhos que esta tarefa pode tocar');
  });

  it('refuses a no-op, an abstention, a repairless finding and a low-confidence guess', () => {
    const reasons = plan([
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'color', token: '{color.ink}' }, { id: 'noop' }),
      finding(undefined, { id: 'bare' }),
      finding({ operation: 'replace_copy', nodeId: 'home-title', text: 'Outro título.' }, { id: 'shy', confidence: 0.2 }),
      { ...finding(undefined, { id: 'abstained' }), abstain: true },
    ]).rejected;
    expect(reasons.map((entry) => `${entry.finding.id}: ${entry.reason}`).join(' | ')).toMatch(/já define color/);
    expect(reasons.find((entry) => entry.finding.id === 'bare')!.reason).toContain('não traz um reparo mínimo');
    expect(reasons.find((entry) => entry.finding.id === 'shy')!.reason).toContain('abaixo do mínimo de 0.5');
    expect(reasons.find((entry) => entry.finding.id === 'abstained')!.reason).toContain('escalou a decisão para o humano');
  });

  it('caps a cycle at three causal repairs and never lets two of them write the same path', () => {
    const many = [0, 1, 2, 3].map((index) => finding({ operation: 'replace_copy', nodeId: 'home-title', text: `Título ${index}.` }, { id: `f${index}`, confidence: 0.9 - index / 100 }));
    const collided = plan(many);
    expect(collided.accepted).toHaveLength(1);
    expect(collided.rejected.map((entry) => entry.reason)).toEqual(expect.arrayContaining([expect.stringContaining('já escreve em')]));

    const spread = [
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' }, { id: 'a' }),
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'padding', token: '{space.md}' }, { id: 'b' }),
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'margin', token: '{space.md}' }, { id: 'c' }),
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'radius', token: '{radius.card}' }, { id: 'd' }),
    ];
    const capped = plan(spread);
    expect(capped.accepted).toHaveLength(3);
    expect(capped.rejected[0]!.reason).toContain('já carrega 3 reparos causais');
  });

  it('ranks blockers before minor observations', () => {
    const result = plan([
      finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' }, { id: 'minor', severity: 'minor' }),
      finding({ operation: 'set_token', nodeId: 'home-proof', prop: 'gap', token: '{space.md}' }, { id: 'blocker', severity: 'blocker' }),
    ]);
    expect(result.accepted.map((repair) => repair.finding.id)).toEqual(['blocker', 'minor']);
  });
});

describe('prototype refiner', () => {
  it('proves the patch on a dry run and lets the applier write the next immutable version', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot(createFixtureIR());
    const reports = [{
      schemaVersion: '1' as const, stage: 'prototype' as const, dimension: 'coherence' as const, criticSessionId: 's',
      perception: { summary: 's', regions: [] },
      comprehension: { hierarchy: 'h', intent: 'i', brandAlignment: 'b' },
      projection: {
        verdict: 'revise' as const,
        rubric: [{ criterion: 'Token fidelity', score: 2, evidence: 'e' }],
        findings: [finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' })],
      },
    }];
    const outcome = new PrototypeRefiner(applier).refine({ ir: base.ir, currentVersionId: base.id, reports, allowedPaths: ['/pages'], idempotencyKey: 'refine-1' });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.version!.parentId).toBe(base.id);
    expect(outcome.version!.ir.pages.routes[0]!.nodes[1]!.props.gap).toBe('{space.md}');
    expect(store.get(base.id)!.ir.pages.routes[0]!.nodes[1]!.props.gap).toBeUndefined();
  });

  it('reports the refusal instead of writing when the gate rejects the patch', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot(createFixtureIR());
    const reports = [{
      schemaVersion: '1' as const, stage: 'prototype' as const, dimension: 'coherence' as const, criticSessionId: 's',
      perception: { summary: 's', regions: [] },
      comprehension: { hierarchy: 'h', intent: 'i', brandAlignment: 'b' },
      projection: {
        verdict: 'revise' as const,
        rubric: [{ criterion: 'Token fidelity', score: 2, evidence: 'e' }],
        findings: [finding({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' })],
      },
    }];
    const outcome = new PrototypeRefiner(applier).refine({ ir: base.ir, currentVersionId: base.id, reports, allowedPaths: ['/pages'], idempotencyKey: 'refine-1' });
    const repeated = new PrototypeRefiner(applier).refine({ ir: base.ir, currentVersionId: base.id, reports, allowedPaths: ['/pages'], idempotencyKey: 'refine-1' });
    expect(outcome.version).toBeDefined();
    expect(repeated.version).toBeUndefined();
    expect(repeated.refusal).toContain('was already accepted');
  });
});

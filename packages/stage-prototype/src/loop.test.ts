import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_BUDGET, decideNextCycle, summariseCycle, type CycleRecord, type CritiqueReport, type Finding, type PatchPlan } from './index.js';

const budget = DEFAULT_LOOP_BUDGET;

function cycle(overrides: Partial<CycleRecord> = {}): CycleRecord {
  return {
    cycle: 1, versionId: 'v1', qaIssueHash: 'q1', vetoes: 0, issueHashes: ['a'], rubricAverage: 3,
    verdicts: ['revise'], appliedFindingIds: ['f1'], rejectedCount: 0, ...overrides,
  };
}

describe('loop stop conditions', () => {
  it('stops on a deterministic veto before spending anything on a model', () => {
    const decision = decideNextCycle([cycle({ vetoes: 2, verdicts: [] })], budget, 0);
    expect(decision).toMatchObject({ proceed: false, reason: 'tier0_veto' });
    expect(decision.detail).toContain('2 falha');
  });

  it('stops clean once every critic passes', () => {
    expect(decideNextCycle([cycle({ verdicts: ['pass', 'pass', 'pass', 'pass'] })], budget, 0)).toMatchObject({ proceed: false, reason: 'clean' });
  });

  it('escalates an uncertain critic instead of iterating against it', () => {
    expect(decideNextCycle([cycle({ verdicts: ['pass', 'uncertain'] })], budget, 0)).toMatchObject({ proceed: false, reason: 'uncertain' });
  });

  it('stops at the cycle ceiling and at the time budget', () => {
    const history = [cycle({ cycle: 1, issueHashes: ['a'] }), cycle({ cycle: 2, issueHashes: ['b'], rubricAverage: 4 }), cycle({ cycle: 3, issueHashes: ['c'], rubricAverage: 4.5 })];
    expect(decideNextCycle(history, budget, 0)).toMatchObject({ proceed: false, reason: 'max_cycles' });
    expect(decideNextCycle([cycle()], budget, budget.deadlineMs)).toMatchObject({ proceed: false, reason: 'budget_exhausted' });
  });

  it('stops when the same problem survives two rounds', () => {
    const history = [cycle({ cycle: 1, issueHashes: ['a', 'b'] }), cycle({ cycle: 2, issueHashes: ['b', 'a'].sort(), rubricAverage: 4 })];
    expect(decideNextCycle(history, budget, 0)).toMatchObject({ proceed: false, reason: 'repeated_issue' });
  });

  it('stops when the rubric moves less than the judge noise', () => {
    const history = [cycle({ cycle: 1, issueHashes: ['a'], rubricAverage: 3 }), cycle({ cycle: 2, issueHashes: ['b'], rubricAverage: 3.1 })];
    const decision = decideNextCycle(history, budget, 0);
    expect(decision).toMatchObject({ proceed: false, reason: 'improvement_below_noise' });
    expect(decision.detail).toContain('0.10');
  });

  it('stops when nothing in the round could be repaired, and says how many were refused', () => {
    const decision = decideNextCycle([cycle({ appliedFindingIds: [], rejectedCount: 4 })], budget, 0);
    expect(decision).toMatchObject({ proceed: false, reason: 'no_actionable_patch' });
    expect(decision.detail).toContain('4 proposta');
  });

  it('earns another cycle only when a repair landed and the rubric actually moved', () => {
    expect(decideNextCycle([cycle()], budget, 0).proceed).toBe(true);
    const history = [cycle({ cycle: 1, issueHashes: ['a'], rubricAverage: 2 }), cycle({ cycle: 2, issueHashes: ['b'], rubricAverage: 3 })];
    expect(decideNextCycle(history, budget, 0).proceed).toBe(true);
    expect(decideNextCycle([], budget, 0).proceed).toBe(true);
  });
});

describe('cycle summary', () => {
  it('collapses a round into the facts the controller needs', () => {
    const finding: Finding = {
      id: 'f1', dimension: 'coherence', severity: 'major',
      evidence: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false, nodeIds: ['home-title'] },
      observation: 'o', why: 'w', confidence: 0.8, checks: [], abstain: false,
      patch: { operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' },
    };
    const report: CritiqueReport = {
      schemaVersion: '1', stage: 'prototype', dimension: 'coherence', criticSessionId: 's',
      perception: { summary: 's', regions: [] },
      comprehension: { hierarchy: 'h', intent: 'i', brandAlignment: 'b' },
      projection: { verdict: 'revise', rubric: [{ criterion: 'c', score: 2, evidence: 'e' }, { criterion: 'd', score: 4, evidence: 'e' }], findings: [finding] },
    };
    const plan: PatchPlan = { accepted: [{ finding, operations: [], paths: [] }], rejected: [{ finding, reason: 'duplicada' }] };
    const record = summariseCycle({ cycle: 2, versionId: 'v2', qaIssueHash: 'q', vetoes: 0, reports: [report], plan });
    expect(record).toMatchObject({ cycle: 2, versionId: 'v2', rubricAverage: 3, verdicts: ['revise'], appliedFindingIds: ['f1'], rejectedCount: 1 });
    expect(record.issueHashes).toHaveLength(1);
  });
});

import { createFixtureIR, type DesignIR } from '@pwb/domain';

export type ControlSeed = 'fixture' | 'off-rhythm';
export const CONTROL_SEEDS: ControlSeed[] = ['fixture', 'off-rhythm'];

/**
 * A control pair for the evaluation loop. The research this stage follows warns that a critic loop
 * measured only against clean input tells you nothing: it also has to be shown a revision with a
 * known defect and be seen to report it. `off-rhythm` declares a grid beat that the identity's own
 * spacing roles cannot land on, so every section inherits spacing outside the declared grammar.
 * Nothing here weakens a contract — the document still validates and still renders from tokens alone.
 */
export function createOffRhythmControlIR(): DesignIR {
  const ir = createFixtureIR();
  const space = ir.identity.tokens.space as Record<string, { $value: string; $type: 'dimension' }>;
  ir.identity.tokens = { ...ir.identity.tokens, space: { ...space, beat: { $value: '0.625rem', $type: 'dimension' } } };
  ir.identity.gridGrammar = { ...ir.identity.gridGrammar, rhythmToken: '{space.beat}' };
  return ir;
}

export function seedFor(seed: ControlSeed): () => DesignIR {
  return seed === 'off-rhythm' ? createOffRhythmControlIR : createFixtureIR;
}

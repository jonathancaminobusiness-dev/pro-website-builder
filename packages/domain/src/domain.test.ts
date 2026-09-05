import { describe, expect, it } from 'vitest';
import {
  DesignIRSchema,
  IdentitySpecSchema,
  PatchSchema,
  createFixtureIR,
  hashJson,
  resolveTokens,
  schemaJson,
} from './index.js';

describe('domain contracts', () => {
  it('accepts the phase 0 fixture and exports model JSON schema', () => {
    const fixture = createFixtureIR();
    expect(DesignIRSchema.parse(fixture).meta.projectId).toBe('fixture-project');
    expect(schemaJson.Patch).toBeDefined();
    expect(PatchSchema.parse({
      operations: [{ op: 'replace', path: '/tokens/color/brand', value: { $value: '#18252d', $type: 'color' } }],
      baseVersionId: 'v1',
      touchedPaths: ['/tokens/color/brand'],
      rationale: 'Fixture patch',
      confidence: 0.9,
      stage: 'identity',
      role: 'director',
    }).operations[0]?.op).toBe('replace');
  });

  it('rejects an identity without the visual contract fields', () => {
    expect(() => IdentitySpecSchema.parse({ meta: { id: 'bad' } })).toThrow();
  });

  it('resolves aliases and rejects circular or orphan aliases', () => {
    const resolved = resolveTokens({
      color: {
        brand: { $value: '#18252d', $type: 'color' },
        action: { $value: '{color.brand}', $type: 'color' },
      },
    });
    expect(resolved.values['color.action']).toBe('#18252d');
    expect(() => resolveTokens({ a: { $value: '{b}', $type: 'color' }, b: { $value: '{a}', $type: 'color' } })).toThrow(/circular/i);
    expect(() => resolveTokens({ a: { $value: '{missing}', $type: 'color' } })).toThrow(/orphan/i);
  });

  it('hashes equivalent objects deterministically', () => {
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
  });
});

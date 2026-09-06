import { describe, expect, it } from 'vitest';
import {
  DesignIRSchema,
  CritiqueReportSchema,
  FindingSchema,
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

  it('rejects a page whose nodes are not reachable from its declared root', () => {
    const orphaned = createFixtureIR();
    orphaned.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title'] };
    expect(() => DesignIRSchema.parse(orphaned)).toThrow(/home-proof is not reachable/i);
    const dangling = createFixtureIR();
    dangling.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'ghost'] };
    expect(() => DesignIRSchema.parse(dangling)).toThrow(/unknown node ghost/i);
    const cyclic = createFixtureIR();
    cyclic.pages.routes[0]!.nodes[1]!.slots = { children: ['home-root'] };
    expect(() => DesignIRSchema.parse(cyclic)).toThrow(/more than once/i);
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

  it('validates review contracts without granting agents mutation authority', () => {
    const finding = FindingSchema.parse({ id: 'TOK-001', severity: 'error', path: '/tokens', message: 'Use a token.' });
    expect(CritiqueReportSchema.parse({ stage: 'prototype', findings: [finding], score: 0.8, summary: 'Typed review.' }).findings).toHaveLength(1);
  });
});

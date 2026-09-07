import { describe, expect, it } from 'vitest';
import {
  designIRSchema,
  identitySpecSchema,
  patchSchema,
  createFixtureIdentity,
  createFixtureIR,
  hashJson,
  resolveTokens,
  schemaJson,
} from './index.js';

describe('domain contracts', () => {
  it('accepts the phase 0 fixture and exports model JSON schema', () => {
    const fixture = createFixtureIR();
    expect(designIRSchema.parse(fixture).meta.projectId).toBe('fixture-project');
    expect(patchSchema.parse({
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
    expect(() => designIRSchema.parse(orphaned)).toThrow(/home-proof is not reachable/i);
    const dangling = createFixtureIR();
    dangling.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'ghost'] };
    expect(() => designIRSchema.parse(dangling)).toThrow(/unknown node ghost/i);
    const cyclic = createFixtureIR();
    cyclic.pages.routes[0]!.nodes[1]!.slots = { children: ['home-root'] };
    expect(() => designIRSchema.parse(cyclic)).toThrow(/more than once/i);
  });

  it('rejects pages that share a route or an id', () => {
    const duplicateRoute = createFixtureIR();
    duplicateRoute.pages.routes[1]!.route = '/contact';
    expect(() => designIRSchema.parse(duplicateRoute)).toThrow(/share the route \/contact/i);
    const duplicateId = createFixtureIR();
    duplicateId.pages.routes[1]!.id = 'page-home';
    expect(() => designIRSchema.parse(duplicateId)).toThrow(/share the id page-home/i);
  });

  it('rejects routes that differ only in case, which one export path cannot keep apart', () => {
    const cased = createFixtureIR();
    cased.pages.routes[1]!.route = '/Contact';
    expect(() => designIRSchema.parse(cased)).toThrow(/share the route/i);
  });

  it('rejects routes that are not already the path the export writes', () => {
    const trailing = createFixtureIR();
    trailing.pages.routes[1]!.route = '/proof/';
    expect(() => designIRSchema.parse(trailing)).toThrow(/segments/i);
    const interior = createFixtureIR();
    interior.pages.routes[1]!.route = '//proof';
    expect(() => designIRSchema.parse(interior)).toThrow(/segments/i);
  });

  it('rejects a node prop the renderer has no vocabulary for', () => {
    const unknown = createFixtureIR();
    (unknown.pages.routes[0]!.nodes[0]!.props as Record<string, string>).letterSpacing = '{space.sm}';
    expect(() => designIRSchema.parse(unknown)).toThrow(/letterSpacing/i);
    const declared = createFixtureIR();
    declared.pages.routes[0]!.nodes[1]!.props.fontWeight = '{type.body}';
    expect(designIRSchema.parse(declared).pages.routes[0]!.nodes[1]!.props.fontWeight).toBe('{type.body}');
  });

  it('rejects an identity without the visual contract fields', () => {
    expect(() => identitySpecSchema.parse({ meta: { id: 'bad' } })).toThrow();
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

  it('requires every identity token role to name a token the identity defines', () => {
    const identity = createFixtureIdentity();
    expect(identitySpecSchema.parse(identity).tokenRoles.surface).toBe('color.paper');
    expect(() => identitySpecSchema.parse({ ...identity, tokenRoles: { ...identity.tokenRoles, surface: 'color.missing' } })).toThrow(/color\.missing/);
  });
});

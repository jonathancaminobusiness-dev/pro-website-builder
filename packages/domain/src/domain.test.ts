import { describe, expect, it } from 'vitest';
import {
  designIRSchema,
  documentRules,
  identitySpecSchema,
  RASTER_IMAGERY_SOURCE,
  patchSchema,
  createFixtureIdentity,
  createFixtureIR,
  hashJson,
  resolveTokens,
  stageResultJsonSchemas,
  visualPropKeys,
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

  it('quotes the rule it enforces for every structural rule the worker contract states', () => {
    const refused = (mutate: (ir: ReturnType<typeof createFixtureIR>) => void): string[] => {
      const ir = createFixtureIR();
      mutate(ir);
      const result = designIRSchema.safeParse(ir);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    const violations: Record<keyof typeof documentRules, () => string[]> = {
      mediaFigure: () => refused((ir) => { (ir.pages.routes[0]!.nodes[2]! as { semantic: string }).semantic = 'figure'; }),
      phrasingLeaf: () => refused((ir) => { ir.pages.routes[0]!.nodes[1]!.slots = { children: ['home-proof'] }; }),
      interactiveControl: () => refused((ir) => {
        const control = ir.pages.routes[0]!.nodes[1]! as { kind: string; semantic: string; props: Record<string, unknown> };
        control.kind = 'component';
        control.semantic = 'link';
        control.props.href = '/precos';
      }),
      pageGraph: () => refused((ir) => { ir.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title'] }; }),
      uniquePages: () => refused((ir) => { ir.pages.routes[1]!.route = '/contact'; }),
      tokenRoles: () => refused((ir) => { ir.identity.tokenRoles.surface = 'color.superficie'; }),
      cssTokens: () => refused((ir) => { (ir.identity.tokens as { color: Record<string, unknown> }).color.papel_claro = { $value: '#f4efe6', $type: 'color' }; }),
      tokenReferences: () => refused((ir) => { ir.pages.routes[0]!.nodes[0]!.props.color = '{color.accent-2}'; }),
      visualPropTokens: () => refused((ir) => { ir.pages.routes[0]!.nodes[1]!.props.color = '#d86445'; }),
      mediaAsset: () => refused((ir) => { ir.pages.routes[0]!.nodes[0]!.assetId = 'missing-asset'; }),
      responsiveWidths: () => refused((ir) => { ir.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: '{space.xl}', props: { padding: '{space.md}' } }, { minWidth: '{space.xl}', props: { padding: '{space.lg}' } }]; }),
    };
    for (const [rule, collect] of Object.entries(violations) as Array<[keyof typeof documentRules, () => string[]]>) {
      const messages = collect();
      expect(messages.some((message) => message.startsWith(documentRules[rule]))).toBe(true);
    }
  });

  it('refuses one node id declared by two routes, because the stylesheet addresses it by id alone', () => {
    const shared = createFixtureIR();
    shared.pages.routes[1]!.nodes[1]!.id = 'home-title';
    shared.pages.routes[1]!.nodes[0]!.slots = { children: ['home-title'] };
    expect(() => designIRSchema.parse(shared)).toThrow(/Node home-title is declared by more than one page/);
    expect(designIRSchema.parse(createFixtureIR()).pages.routes[1]!.nodes[1]!.id).toBe('proof-title');
  });

  it('holds a responsive rule to the same token contract as the props beside it', () => {
    const raw = createFixtureIR();
    raw.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: '{breakpoint.compact}', props: { gap: '1rem' } }];
    expect(() => designIRSchema.parse(raw)).toThrow(/sets responsive \{breakpoint\.compact\} gap to 1rem, which is not a token reference/);

    const undefinedToken = createFixtureIR();
    undefinedToken.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: '{breakpoint.compact}', props: { gap: '{space.absent}' } }];
    expect(() => designIRSchema.parse(undefinedToken)).toThrow(/which the identity does not define/);

    const tokenised = createFixtureIR();
    tokenised.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: '{breakpoint.compact}', props: { gap: '{space.lg}' } }];
    expect(designIRSchema.parse(tokenised).pages.routes[0]!.nodes[0]!.responsive[0]!.props.gap).toBe('{space.lg}');
  });

  it('refuses a document whose token aliases or prop references do not resolve, and keeps legal aliases', () => {
    const orphanAlias = createFixtureIR();
    (orphanAlias.identity.tokens as { color: Record<string, unknown> }).color.link = { $value: '{color.ausente}', $type: 'color' };
    expect(() => designIRSchema.parse(orphanAlias)).toThrow(/Orphan token alias: color\.ausente/);
    const aliased = createFixtureIR();
    (aliased.identity.tokens as { color: Record<string, unknown> }).color.link = { $value: '{color.accent}', $type: 'color' };
    aliased.pages.routes[0]!.nodes[1]!.props.color = '{color.link}';
    expect(designIRSchema.parse(aliased).pages.routes[0]!.nodes[1]!.props.color).toBe('{color.link}');
    // The alias resolves to whatever the token it points at holds, so this stays
    // true when the fixture palette changes.
    const accent = resolveTokens(aliased.identity.tokens).values['color.accent'];
    expect(resolveTokens(aliased.identity.tokens).values['color.link']).toBe(accent);
  });

  it('refuses an asset that records no license, at the gate that writes it', () => {
    const unlicensed = createFixtureIR();
    unlicensed.assets.items[0]!.provenance.license = '';
    expect(() => designIRSchema.parse(unlicensed)).toThrow(/must record the license/i);
    expect(designIRSchema.parse(createFixtureIR()).assets.items[0]!.provenance.license).toBe('internal fixture');
  });

  it('rejects a node semantic the renderer would not emit for that kind', () => {
    const landmark = createFixtureIR();
    (landmark.pages.routes[0]!.nodes[0]! as { semantic: string }).semantic = 'nav';
    expect(() => designIRSchema.parse(landmark)).toThrow(/nav/);
    const heading = createFixtureIR();
    (heading.pages.routes[0]!.nodes[1]! as { semantic: string }).semantic = 'h4';
    expect(() => designIRSchema.parse(heading)).toThrow(/h4/);
    const figure = createFixtureIR();
    (figure.pages.routes[0]!.nodes[2]! as { semantic: string }).semantic = 'figure';
    expect(() => designIRSchema.parse(figure)).toThrow(/media node renders as figure/i);
    const relabelled = createFixtureIR();
    (relabelled.pages.routes[0]!.nodes[0]! as { semantic: string }).semantic = 'section';
    expect(designIRSchema.parse(relabelled).pages.routes[0]!.nodes[0]!.semantic).toBe('section');
  });

  it('rejects node text the renderer cannot write into the page', () => {
    const numeric = createFixtureIR();
    (numeric.pages.routes[0]!.nodes[1]!.props as Record<string, unknown>).text = 2026;
    expect(() => designIRSchema.parse(numeric)).toThrow(/expected string/i);
    const written = designIRSchema.parse(createFixtureIR());
    expect(written.pages.routes[0]!.nodes[1]!.props.text).toBe('Toda escolha tem motivo.');
  });

  it('rejects a node prop the renderer has no vocabulary for', () => {
    const unknown = createFixtureIR();
    (unknown.pages.routes[0]!.nodes[0]!.props as Record<string, string>).letterSpacing = '{space.sm}';
    expect(() => designIRSchema.parse(unknown)).toThrow(/letterSpacing/i);
    const declared = createFixtureIR();
    declared.pages.routes[0]!.nodes[1]!.props.fontWeight = '{type.body}';
    expect(designIRSchema.parse(declared).pages.routes[0]!.nodes[1]!.props.fontWeight).toBe('{type.body}');
  });

  it('admits exactly the visual prop values the gate accepts in the schema the worker is handed', () => {
    const declared = (node: unknown, found: Array<{ type?: string; pattern?: string }> = []): Array<{ type?: string; pattern?: string }> => {
      if (Array.isArray(node)) { for (const item of node) declared(item, found); return found; }
      if (!node || typeof node !== 'object') return found;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const prop of visualPropKeys) { const entry = (value as Record<string, unknown>)[prop]; if (entry) found.push(entry as { type?: string; pattern?: string }); }
        }
        declared(value, found);
      }
      return found;
    };
    const emitted = declared(stageResultJsonSchemas.prototype);
    expect(emitted.length).toBeGreaterThanOrEqual(visualPropKeys.size);
    for (const entry of emitted) {
      expect(entry.type).toBe('string');
      const admits = new RegExp(entry.pattern!);
      expect(admits.test('{type.body}')).toBe(true);
      expect(admits.test('700')).toBe(false);
      expect(admits.test('#d86445')).toBe(false);
    }
    const numeric = createFixtureIR();
    (numeric.pages.routes[0]!.nodes[1]!.props as Record<string, unknown>).fontWeight = 700;
    const refusal = designIRSchema.safeParse(numeric);
    expect(refusal.success).toBe(false);
    expect(refusal.success ? [] : refusal.error.issues.map((issue) => issue.message)).toContain(documentRules.visualPropTokens);
  });

  it('treats an Object.prototype key as a token the identity does not define', () => {
    const inherited = createFixtureIR();
    inherited.pages.routes[0]!.nodes[1]!.props.color = '{constructor}';
    const refusal = designIRSchema.safeParse(inherited);
    expect(refusal.success).toBe(false);
    expect(refusal.success ? [] : refusal.error.issues.map((issue) => issue.message)).toContainEqual(expect.stringContaining('{constructor}'));
    const shadowing = resolveTokens(JSON.parse('{"toString":{"$value":"#101010","$type":"color"}}'));
    expect(shadowing.values['toString']).toBe('#101010');
    expect(Object.keys(shadowing.values)).toEqual(['toString']);
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

  it('accepts only the closed imagery source vocabulary, which is what decides generation', () => {
    const identity = createFixtureIdentity();
    expect(identitySpecSchema.parse(identity).imagery.allowedSources).toContain(RASTER_IMAGERY_SOURCE);
    expect(() => identitySpecSchema.parse({ ...identity, imagery: { ...identity.imagery, allowedSources: ['MCP Higgsfield'] } })).toThrow();
    expect(() => identitySpecSchema.parse({ ...identity, imagery: { ...identity.imagery, allowedSources: ['manual'] } })).not.toThrow();
  });

  it('requires every identity token role to name a token the identity defines', () => {
    const identity = createFixtureIdentity();
    expect(identitySpecSchema.parse(identity).tokenRoles.surface).toBe('color.paper');
    expect(() => identitySpecSchema.parse({ ...identity, tokenRoles: { ...identity.tokenRoles, surface: 'color.missing' } })).toThrow(/color\.missing/);
  });

  it('requires the grid grammar breakpoints to rise above the narrowest viewport', () => {
    const identity = createFixtureIdentity();
    const grammar = (breakpointTokens: string[]): unknown => ({ ...identity, gridGrammar: { ...identity.gridGrammar, breakpointTokens } });

    const widths = identitySpecSchema.parse(identity).gridGrammar.breakpointTokens;
    expect(widths).toHaveLength(2);
    // The content max width is 6rem here: a container query opening there matches every viewport.
    expect(() => identitySpecSchema.parse(grammar([identity.gridGrammar.maxWidthToken, '{breakpoint.expanded}']))).toThrow(/not above 320px/);
    expect(() => identitySpecSchema.parse(grammar(['{breakpoint.expanded}', '{breakpoint.compact}']))).toThrow(/not above 960px/);
    expect(() => identitySpecSchema.parse(grammar(['{breakpoint.compact}', '{type.body}']))).toThrow(/does not resolve to a dimension/);
    expect(() => identitySpecSchema.parse(grammar(['{breakpoint.compact}']))).toThrow();
  });
});

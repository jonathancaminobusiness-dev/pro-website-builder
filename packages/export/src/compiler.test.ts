import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, designIRSchema, type DesignIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { appendReleasePublication, compileRelease, readBundleHashes, readReleasePublications, ReleaseVetoError, writeReleaseBundle, type CompiledSite } from './index.js';

const OPTIONS = { siteUrl: 'https://oficina.example', siteName: 'Oficina' };

function compileFixture(mutate?: (ir: DesignIR) => void): CompiledSite {
  const ir = createFixtureIR();
  mutate?.(ir);
  return compileRelease(renderDesign(ir), ir, OPTIONS);
}

/** The fixture home page showing the mark it declares, so the bundle carries the asset's bytes. */
function withInlinedMark(ir: DesignIR): void {
  const home = ir.pages.routes[0]!;
  home.nodes.find((node) => node.id === 'home-root')!.slots.children!.push('home-mark');
  home.nodes.push({ id: 'home-mark', kind: 'media', semantic: 'figure', props: { text: 'Marca da oficina' }, slots: {}, assetId: 'fixture-mark', responsive: [] });
}

/** The fixture home page extended with the three semantics its own document never exercises. */
function withInteractiveHome(ir: DesignIR): void {
  const home = ir.pages.routes[0]!;
  home.nodes.find((node) => node.id === 'home-root')!.slots.children!.push('home-root-link', 'home-proof-link', 'home-cta');
  home.nodes.push(
    { id: 'home-root-link', kind: 'component', semantic: 'link', props: { text: 'Início', href: '/' }, slots: {}, responsive: [] },
    { id: 'home-proof-link', kind: 'component', semantic: 'link', props: { text: 'Ver a prova', href: '/proof' }, slots: {}, responsive: [] },
    { id: 'home-cta', kind: 'component', semantic: 'button', props: { text: 'Falar com a oficina' }, slots: {}, responsive: [] },
  );
  withInlinedMark(ir);
}

/** One licence inventory row of the compiled bundle, read out of the published `licenses.json`. */
function licenseRow(compiled: CompiledSite, id: string): Record<string, unknown> | undefined {
  return (JSON.parse(fileText(compiled, 'licenses.json')) as Array<Record<string, unknown> & { id: string }>).find((entry) => entry.id === id);
}

/** One directive of a published Content-Security-Policy, read as the browser parses it. */
function policyDirective(policy: string, name: string): string | undefined {
  const directive = policy.split(';').map((part) => part.trim()).find((part) => part === name || part.startsWith(`${name} `));
  return directive === undefined ? undefined : directive.slice(name.length).trim();
}

function fileText(compiled: CompiledSite, path: string): string {
  const file = compiled.files.find((candidate) => candidate.path === path);
  if (!file || typeof file.contents !== 'string') throw new Error(`The bundle has no text file at ${path}. It has: ${compiled.files.map((entry) => entry.path).join(', ')}`);
  return file.contents;
}

describe('deterministic release compiler', () => {
  it('compiles the approved fixture with no veto and writes every release file', () => {
    const compiled = compileFixture();
    expect(compiled.vetoes).toEqual([]);
    const paths = compiled.files.map((file) => file.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('proof/index.html');
    expect(paths).toContain('contact/index.html');
    expect(paths).toContain('sitemap.xml');
    expect(paths).toContain('robots.txt');
    expect(paths).toContain('licenses.json');
    expect(paths).toContain('headers.json');
    expect(paths).toContain(compiled.stylesheetPath);
    expect(paths).toEqual([...paths].sort());
  });

  it('moves every inline style into the stylesheet so the policy can forbid inline styles', () => {
    const compiled = compileFixture();
    const home = fileText(compiled, 'index.html');
    expect(home).not.toMatch(/ style="/);
    expect(home).not.toContain('<style>');
    expect(home).toContain(`<link rel="stylesheet" href="/${compiled.stylesheetPath}">`);
    const stylesheet = fileText(compiled, compiled.stylesheetPath);
    expect(stylesheet).toContain('[data-node-id="home-title"] { color: var(--color-ink); font-family: var(--type-display); }');
    expect(compiled.csp).toContain("style-src 'self'");
    expect(compiled.csp).toContain("script-src 'none'");
  });

  it('delivers a policy in the document without the directives a meta tag must ignore', () => {
    const compiled = compileFixture();
    const home = fileText(compiled, 'index.html');
    expect(home).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(home).not.toContain('frame-ancestors');
    expect(compiled.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(fileText(compiled, 'headers.json')).toContain('frame-ancestors');
  });

  it('writes per-route metadata, Open Graph and a canonical URL derived from the page', () => {
    const compiled = compileFixture();
    const home = fileText(compiled, 'index.html');
    expect(home).toContain('<link rel="canonical" href="https://oficina.example/">');
    expect(home).toContain('<meta property="og:title" content="Oficina — início">');
    expect(home).toContain('<meta property="og:url" content="https://oficina.example/">');
    expect(home).toContain('<meta property="og:locale" content="pt_BR">');
    expect(home).toContain('<meta name="description" content="Processo rastreável.">');
    expect(fileText(compiled, 'proof/index.html')).toContain('<link rel="canonical" href="https://oficina.example/proof/">');
    expect(compiled.routes.find((route) => route.route === '/proof')?.ogType).toBe('article');
  });

  it('falls back to the identity promise when a route has no body text of its own', () => {
    const compiled = compileFixture();
    expect(fileText(compiled, 'contact/index.html')).toContain('<meta name="description" content="Clareza com personalidade">');
  });

  it('emits a sitemap and robots file that agree with the canonical URLs', () => {
    const compiled = compileFixture();
    const sitemap = fileText(compiled, 'sitemap.xml');
    for (const route of compiled.routes) expect(sitemap).toContain(`<loc>${route.canonical}</loc>`);
    expect(fileText(compiled, 'robots.txt')).toContain('Sitemap: https://oficina.example/sitemap.xml');
  });

  it('links its assets from the site base path so a sub-path deployment resolves them', () => {
    const ir = createFixtureIR();
    const compiled = compileRelease(renderDesign(ir), ir, { ...OPTIONS, siteUrl: 'https://oficina.example/estudio' });
    expect(compiled.vetoes).toEqual([]);
    const home = compiled.files.find((file) => file.path === 'index.html')!.contents as string;
    expect(home).toContain(`<link rel="stylesheet" href="/estudio/${compiled.stylesheetPath}">`);
    expect(home).toContain('<link rel="canonical" href="https://oficina.example/estudio/">');
  });

  it('links a self-hosted face relative to the stylesheet that references it', () => {
    const ir = createFixtureIR();
    const compiled = compileRelease(renderDesign(ir), ir, {
      ...OPTIONS,
      siteUrl: 'https://oficina.example/estudio',
      fonts: [{ family: 'Fraunces', weight: '400', style: 'normal', format: 'woff2', bytes: new Uint8Array([1, 2, 3]), license: 'OFL-1.1', source: 's', author: 'a', date: '2026-09-05' }],
    });
    const stylesheet = compiled.files.find((file) => file.path === compiled.stylesheetPath)!.contents as string;
    expect(stylesheet).toMatch(/src:url\("fonts\/fraunces-400-normal\.[0-9a-f]{12}\.woff2"\)/);
    expect(stylesheet).not.toContain('url("/assets');
  });

  it('compiles a document that carries a link, a button and a ready media asset', () => {
    const ir = createFixtureIR();
    withInteractiveHome(ir);
    expect(designIRSchema.safeParse(ir).success).toBe(true);
    const compiled = compileRelease(renderDesign(ir), ir, OPTIONS);
    expect(compiled.vetoes).toEqual([]);
    const home = fileText(compiled, 'index.html');
    expect(home).toContain('<a href="/proof"');
    expect(home).toContain('<button type="button"');
    expect(home).toContain(`<img src="${ir.assets.items[0]!.uri}"`);
  });

  it('resolves a link to the site root as well as to a nested route, base path or not', () => {
    const ir = createFixtureIR();
    withInteractiveHome(ir);
    for (const siteUrl of ['https://oficina.example', 'https://oficina.example/estudio']) {
      const compiled = compileRelease(renderDesign(ir), ir, { ...OPTIONS, siteUrl });
      expect(compiled.vetoes.filter((veto) => veto.id === 'BROKEN_PRIMARY_LINK')).toEqual([]);
    }
  });

  it('refuses a site URL that is not an absolute origin', () => {
    const ir = createFixtureIR();
    expect(() => compileRelease(renderDesign(ir), ir, { ...OPTIONS, siteUrl: '/relative' })).toThrow(/absolute http\(s\) site URL/i);
  });
});

describe('release vetoes', () => {
  it('refuses to export an asset without a usable licence', async () => {
    const compiled = compileFixture((ir) => { withInlinedMark(ir); ir.assets.items[0]!.provenance.license = '  '; });
    expect(compiled.vetoes.map((veto) => veto.id)).toContain('ASSET_WITHOUT_LICENSE');
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await expect(writeReleaseBundle(compiled, root)).rejects.toBeInstanceOf(ReleaseVetoError);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats an unresolved licence placeholder as no licence at all', () => {
    const compiled = compileFixture((ir) => { withInlinedMark(ir); ir.assets.items[0]!.provenance.license = 'pending provider terms'; });
    expect(compiled.vetoes.map((veto) => veto.id)).toContain('ASSET_WITHOUT_LICENSE');
  });

  it('refuses to export a bundle that carries a secret', async () => {
    const compiled = compileFixture((ir) => {
      const node = ir.pages.routes[0]!.nodes.find((candidate) => candidate.id === 'home-title')!;
      node.props.text = 'sk-ant-api03-0123456789abcdefghijklmnop';
    });
    expect(compiled.vetoes.map((veto) => veto.id)).toContain('SECRET_IN_BUNDLE');
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await expect(writeReleaseBundle(compiled, root)).rejects.toThrow(/SECRET_IN_BUNDLE/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('vetoes an executable URL without objecting to the anchor that carries it', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes[0]!.html = rendered.routes[0]!.html.replace('</body>', '<a href="javascript:alert(1)">x</a></body>');
    const compiled = compileRelease(rendered, ir, OPTIONS);
    const ids = compiled.vetoes.map((veto) => veto.id);
    expect(ids).toContain('XSS_OR_JAVASCRIPT_URL');
    expect(ids).not.toContain('UNSANITIZED_HTML');
  });

  it('vetoes an element the deterministic renderer never produces', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes[0]!.html = rendered.routes[0]!.html.replace('</body>', '<script>alert(1)</script></body>');
    const compiled = compileRelease(rendered, ir, OPTIONS);
    expect(compiled.vetoes.find((veto) => veto.id === 'UNSANITIZED_HTML')?.detail).toContain('<script>');
  });

  it('finds a secret whose quotes the renderer escaped', () => {
    const compiled = compileFixture((ir) => {
      ir.pages.routes[0]!.nodes.find((candidate) => candidate.id === 'home-title')!.props.text = 'api_key: "AbCdEf123456789"';
    });
    expect(compiled.vetoes.map((veto) => veto.id)).toContain('SECRET_IN_BUNDLE');
  });

  it('vetoes an inline event handler', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes[0]!.html = rendered.routes[0]!.html.replace('<body>', '<body onload="steal()">');
    expect(compileRelease(rendered, ir, OPTIONS).vetoes.map((veto) => veto.id)).toContain('XSS_OR_JAVASCRIPT_URL');
  });

  it('vetoes a primary link that the bundle cannot serve', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes[0]!.html = rendered.routes[0]!.html.replace('</body>', '<link rel="preload" href="/assets/missing.css"></body>');
    const veto = compileRelease(rendered, ir, OPTIONS).vetoes.find((candidate) => candidate.id === 'BROKEN_PRIMARY_LINK');
    expect(veto?.detail).toContain('/assets/missing.css');
  });

  it('vetoes a route the renderer failed to produce', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes.splice(1, 1);
    const ids = compileRelease(rendered, ir, OPTIONS).vetoes.map((veto) => veto.id);
    expect(ids).toContain('BUILD_FAILED');
    expect(ids).toContain('BROKEN_PRIMARY_LINK');
  });

  it('vetoes a font stack with no generic family to fall back to', () => {
    const compiled = compileFixture((ir) => { ir.identity.tokens.type = { ...(ir.identity.tokens.type as object), body: { $value: '"Only Me"', $type: 'fontFamily' } } as never; });
    const veto = compiled.vetoes.find((candidate) => candidate.id === 'BUILD_FAILED');
    expect(veto?.detail).toMatch(/generic family/);
  });
});

interface CascadeEnvironment { dark: boolean; modern: boolean }
interface CascadeDeclaration { layer: string | undefined; property: string; value: string }

/** The blocks at one nesting level of a stylesheet, with `@layer a, b;` statements skipped. */
function cssBlocks(css: string): Array<{ prelude: string; body: string }> {
  const blocks: Array<{ prelude: string; body: string }> = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const statement = css.indexOf(';', index);
    if (statement !== -1 && statement < open) { index = statement + 1; continue; }
    let depth = 0;
    let close = -1;
    for (let cursor = open; cursor < css.length; cursor += 1) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') { depth -= 1; if (depth === 0) { close = cursor; break; } }
    }
    if (close === -1) break;
    blocks.push({ prelude: css.slice(index, open).trim(), body: css.slice(open + 1, close) });
    index = close + 1;
  }
  return blocks;
}

function collectRootDeclarations(css: string, layer: string | undefined, environment: CascadeEnvironment, into: CascadeDeclaration[]): void {
  for (const block of cssBlocks(css)) {
    if (block.prelude.startsWith('@layer')) { collectRootDeclarations(block.body, block.prelude.slice('@layer'.length).trim(), environment, into); continue; }
    if (block.prelude.startsWith('@media')) {
      if (/prefers-color-scheme:\s*dark/.test(block.prelude) && !environment.dark) continue;
      collectRootDeclarations(block.body, layer, environment, into);
      continue;
    }
    if (block.prelude.startsWith('@supports')) {
      if (environment.modern) collectRootDeclarations(block.body, layer, environment, into);
      continue;
    }
    if (block.prelude !== ':root') continue;
    for (const line of block.body.split('\n')) {
      const declaration = /^\s*(--[A-Za-z0-9_-]+):\s*(.+);\s*$/.exec(line);
      if (declaration) into.push({ layer, property: declaration[1]!, value: declaration[2]! });
    }
  }
}

/**
 * The value a browser resolves for one `:root` custom property, read out of the
 * compiled stylesheet — the bundle's own public artifact — the way the cascade
 * reads it: an unlayered author declaration outranks every layered one, a later
 * layer outranks an earlier one, and source order decides inside a layer.
 */
function resolveCustomProperty(stylesheet: string, property: string, environment: CascadeEnvironment): string | undefined {
  const declared = /@layer ([^{;]+);/.exec(stylesheet);
  const order = declared ? declared[1]!.split(',').map((name) => name.trim()) : [];
  const declarations: CascadeDeclaration[] = [];
  collectRootDeclarations(stylesheet, undefined, environment, declarations);
  const rank = (entry: CascadeDeclaration): number => (entry.layer === undefined ? Number.POSITIVE_INFINITY : order.indexOf(entry.layer));
  let winner: CascadeDeclaration | undefined;
  for (const entry of declarations) {
    if (entry.property !== property) continue;
    if (winner === undefined || rank(entry) >= rank(winner)) winner = entry;
  }
  return winner?.value;
}

const DARK_INK = 'oklch(25% 0.03 220)';
const DARK_PAPER = 'oklch(96% 0.02 80)';

/** An identity whose colours need an sRGB companion and which declares a dark scheme that swaps two roles. */
function withDarkScheme(): CompiledSite {
  return compileFixture((ir) => {
    ir.identity.tokens.color = {
      ink: { $value: DARK_INK, $type: 'color' },
      paper: { $value: DARK_PAPER, $type: 'color' },
      accent: { $value: 'oklch(65% 0.15 40)', $type: 'color' },
      muted: { $value: '#607078', $type: 'color' },
    } as never;
    ir.identity.schemes = { dark: { 'color.paper': 'color.ink', 'color.ink': 'color.paper' } };
  });
}

describe('the sRGB fallback does not change which declaration wins', () => {
  it('still gives a browser that supports the modern syntax the identity dark scheme', () => {
    const compiled = withDarkScheme();
    expect(compiled.vetoes).toEqual([]);
    const stylesheet = fileText(compiled, compiled.stylesheetPath);
    expect(resolveCustomProperty(stylesheet, '--color-paper', { dark: true, modern: true })).toBe(DARK_INK);
    expect(resolveCustomProperty(stylesheet, '--color-ink', { dark: true, modern: true })).toBe(DARK_PAPER);
    expect(resolveCustomProperty(stylesheet, '--color-paper', { dark: false, modern: true })).toBe(DARK_PAPER);
  });

  it('gives a browser without the modern syntax a readable sRGB value on either scheme', () => {
    const compiled = withDarkScheme();
    const stylesheet = fileText(compiled, compiled.stylesheetPath);
    const light = resolveCustomProperty(stylesheet, '--color-paper', { dark: false, modern: false });
    const dark = resolveCustomProperty(stylesheet, '--color-paper', { dark: true, modern: false });
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toBe(resolveCustomProperty(stylesheet, '--color-ink', { dark: false, modern: false }));
    expect(dark).not.toBe(light);
  });
});

describe('colour and font fallbacks in the compiled stylesheet', () => {
  function withOklch(): CompiledSite {
    return compileFixture((ir) => {
      ir.identity.tokens.color = {
        ink: { $value: 'oklch(25% 0.03 220)', $type: 'color' },
        paper: { $value: 'oklch(96% 0.02 80)', $type: 'color' },
        accent: { $value: 'oklch(65% 0.15 40)', $type: 'color' },
        muted: { $value: '#607078', $type: 'color' },
      } as never;
    });
  }

  it('declares an sRGB hex in the token layer and re-declares the authored value behind @supports', () => {
    const compiled = withOklch();
    expect(compiled.vetoes).toEqual([]);
    const stylesheet = fileText(compiled, compiled.stylesheetPath);
    expect(stylesheet).toMatch(/--color-ink: #[0-9a-f]{6};/);
    expect(stylesheet).toContain('@supports (color: oklch(0% 0 0))');
    expect(stylesheet).toContain('--color-ink: oklch(25% 0.03 220);');
    expect(stylesheet.indexOf('--color-ink: #')).toBeLessThan(stylesheet.indexOf('@supports'));
  });

  it('gives a shadow token an sRGB companion instead of blocking the release', () => {
    const compiled = compileFixture((ir) => {
      ir.identity.tokens.shadow = { card: { $value: '0 18px 44px oklch(30% 0.02 250 / 0.12)', $type: 'shadow' } } as never;
      ir.pages.routes[0]!.nodes.find((node) => node.id === 'home-proof')!.props.shadow = '{shadow.card}';
    });
    expect(compiled.vetoes).toEqual([]);
    const stylesheet = fileText(compiled, compiled.stylesheetPath);
    expect(stylesheet).toContain('--shadow-card: 0 18px 44px #');
    expect(stylesheet).toContain('--shadow-card: 0 18px 44px oklch(30% 0.02 250 / 0.12);');
  });

  it('vetoes a colour the compiler cannot express in sRGB rather than shipping an unreadable page', () => {
    const compiled = compileFixture((ir) => {
      ir.identity.tokens.color = { ...(ir.identity.tokens.color as object), accent: { $value: 'color-mix(in oklab, #d86445, white)', $type: 'color' } } as never;
    });
    expect(compiled.vetoes.find((veto) => veto.id === 'BUILD_FAILED')?.detail).toMatch(/color-mix/);
  });

  it('self-hosts a font whose licence permits it and leaves an unclear licence unbundled', () => {
    const ir = createFixtureIR();
    const bytes = new Uint8Array([119, 79, 70, 50, 1, 2, 3, 4]);
    const compiled = compileRelease(renderDesign(ir), ir, {
      ...OPTIONS,
      fonts: [
        { family: 'Fraunces', weight: '400', style: 'normal', format: 'woff2', bytes, license: 'OFL-1.1', source: 'https://fonts.example/fraunces', author: 'Undercase', date: '2026-09-05' },
        { family: 'Proprietary Grotesk', weight: '400', style: 'normal', format: 'woff2', bytes, license: 'Foundry desktop licence', source: 'foundry invoice 42', author: 'Foundry', date: '2026-09-05' },
      ],
    });
    expect(compiled.vetoes).toEqual([]);
    const hosted = compiled.fonts.find((font) => font.family === 'Fraunces');
    expect(hosted?.selfHosted).toBe(true);
    expect(compiled.files.some((file) => file.path === hosted?.path)).toBe(true);
    expect(fileText(compiled, compiled.stylesheetPath)).toContain('font-display:swap');
    const unhosted = compiled.fonts.find((font) => font.family === 'Proprietary Grotesk');
    expect(unhosted?.selfHosted).toBe(false);
    expect(unhosted?.reason).toMatch(/does not clearly permit/);
    expect(fileText(compiled, 'licenses.json')).toContain('Proprietary Grotesk');
  });

});

describe('the licence inventory names only the bytes the bundle ships', () => {
  it('lists every asset, font and the toolchain', () => {
    const compiled = compileFixture();
    const inventory = JSON.parse(fileText(compiled, 'licenses.json')) as Array<{ id: string }>;
    expect(inventory.map((entry) => entry.id)).toContain('fixture-mark');
    expect(inventory.map((entry) => entry.id)).toContain('toolchain:pro-website-builder');
  });

  it('marks an asset the document inlines as bundled and carries its bytes in the route', () => {
    const compiled = compileFixture(withInlinedMark);
    expect(licenseRow(compiled, 'fixture-mark')?.bundled).toBe(true);
    expect(fileText(compiled, 'index.html')).toContain(createFixtureIR().assets.items[0]!.uri);
  });

  it('does not claim an asset no page references, and escalates its terms instead of vetoing', () => {
    const compiled = compileFixture((ir) => { ir.assets.items[0]!.provenance.license = 'pending provider terms'; });
    expect(licenseRow(compiled, 'fixture-mark')?.bundled).toBe(false);
    expect(compiled.vetoes.map((veto) => veto.id)).not.toContain('ASSET_WITHOUT_LICENSE');
    expect(compiled.licenses.warnings.map((warning) => warning.id)).toContain('fixture-mark');
  });

  it('states the provenance the owner declared for an asset the bundle ships', () => {
    const compiled = compileFixture((ir) => {
      withInlinedMark(ir);
      ir.assets.items[0]!.provenance.termsNote = 'Fatura 12345 licenciada para o dono';
    });
    expect(licenseRow(compiled, 'fixture-mark')).toMatchObject({
      bundled: true, source: 'fixture', author: 'pro-website-builder', date: '2026-09-05', termsNote: 'Fatura 12345 licenciada para o dono',
    });
  });

  it('names an asset the bundle does not ship without publishing what the owner declared', () => {
    const compiled = compileFixture((ir) => {
      ir.assets.items[0]!.provenance = {
        source: 'https://stock.example/mark', author: 'Estúdio Contratado', license: 'Stock Standard',
        date: '2026-09-05', hash: 'fixture-mark', termsNote: 'Fatura 12345 licenciada para o dono',
      };
    });
    expect(licenseRow(compiled, 'fixture-mark')).toMatchObject({
      id: 'fixture-mark', kind: 'vector', license: 'Stock Standard', bundled: false,
      source: 'not bundled', author: '', date: '', hash: '',
    });
    const published = fileText(compiled, 'licenses.json');
    expect(published).not.toContain('Fatura 12345');
    expect(published).not.toContain('Estúdio Contratado');
    expect(published).not.toContain('stock.example');
  });

  it('does not claim an asset the page shows no image for, remote or not', () => {
    const remote = 'https://higgsfield.example/mark.png';
    const compiled = compileFixture((ir) => {
      withInlinedMark(ir);
      ir.assets.items[0] = { ...ir.assets.items[0]!, uri: remote, status: 'placeholder' };
    });
    expect(licenseRow(compiled, 'fixture-mark')?.bundled).toBe(false);
    expect(fileText(compiled, 'index.html')).not.toContain('<img');
  });
});

describe('the published policy allows only what the bundle can load', () => {
  it('states an image policy no declared origin can widen', () => {
    const compiled = compileFixture((ir) => {
      ir.assets.items[0] = { ...ir.assets.items[0]!, uri: 'https://provider.example/hero.png', status: 'placeholder' };
    });
    const delivered = (JSON.parse(fileText(compiled, 'headers.json')) as Record<string, Record<string, string>>)['/*']!['Content-Security-Policy']!;
    expect(policyDirective(compiled.csp, 'img-src')).toBe("'self' data:");
    expect(policyDirective(delivered, 'img-src')).toBe("'self' data:");
    expect(fileText(compiled, 'index.html')).not.toContain('provider.example');
  });
});

describe('immutable content-addressed bundle', () => {
  it('reproduces the same digest and the same bytes from the same IR and toolchain', async () => {
    const first = compileFixture();
    const second = compileFixture();
    expect(second.digest).toBe(first.digest);
    expect(second.files.map((file) => [file.path, file.hash])).toEqual(first.files.map((file) => [file.path, file.hash]));

    const rootA = await mkdtemp(join(tmpdir(), 'pwb-release-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'pwb-release-b-'));
    try {
      const manifestA = await writeReleaseBundle(first, rootA);
      const manifestB = await writeReleaseBundle(second, rootB);
      expect(await readBundleHashes(rootA, manifestA)).toEqual(await readBundleHashes(rootB, manifestB));
      // Two roots, one manifest: the bundle names nothing about the machine that
      // compiled it, so the published artifact leaks no host path.
      expect(manifestA).toEqual(manifestB);
      const raw = await readFile(join(rootA, first.digest, 'manifest.json'), 'utf8');
      expect(raw).not.toMatch(/createdAt|timestamp/i);
      expect(raw).not.toContain(rootA);
      await stat(join(rootA, first.digest, 'index.html'));
    } finally { await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); }
  });

  it('changes the digest when the document changes', () => {
    const base = compileFixture();
    const changed = compileFixture((ir) => { ir.pages.routes[0]!.title = 'Oficina — outra coisa'; });
    expect(changed.digest).not.toBe(base.digest);
  });

  it('publishes the same bytes twice and refuses a manifest that stopped describing them', async () => {
    const compiled = compileFixture();
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    const manifestPath = join(root, compiled.digest, 'manifest.json');
    try {
      // The manifest names no document and no publication, so a second write of
      // the same release is an idempotent success rather than a collision.
      const first = await writeReleaseBundle(compiled, root);
      const raw = await readFile(manifestPath, 'utf8');
      expect(JSON.parse(raw)).not.toHaveProperty('approvedVersionId');
      expect(JSON.parse(raw)).not.toHaveProperty('irHash');
      await expect(writeReleaseBundle(compiled, root)).resolves.toEqual(first);
      expect(await readFile(manifestPath, 'utf8')).toBe(raw);

      await writeFile(manifestPath, JSON.stringify({ digest: compiled.digest, files: [] }), 'utf8');
      await expect(writeReleaseBundle(compiled, root)).rejects.toThrow(/never rewritten/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps every publication of one bundle in the release record beside it', async () => {
    const compiled = compileFixture();
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await writeReleaseBundle(compiled, root);
      const entry = { digest: compiled.digest, approvedVersionId: 'v-approved', releasedVersionId: 'v-refined', irHash: compiled.irHash, approverRole: 'captain', rationale: 'Firefox não sobe aqui.', acceptedEscalations: ['Nenhuma execução Playwright em firefox.'] };
      await appendReleasePublication(root, entry);
      await appendReleasePublication(root, { ...entry, releasedVersionId: 'v-refined-again', rationale: 'Republicado com outra proveniência.' });
      const record = await readReleasePublications(root, compiled.digest);
      expect(record).toHaveLength(2);
      expect(record[0]).toEqual(entry);
      expect(record[1]?.releasedVersionId).toBe('v-refined-again');
      // The record lives beside the bundle, never inside the immutable directory.
      expect(await readdir(join(root, compiled.digest))).not.toContain(`${compiled.digest}.publications.json`);

      // A damaged record refuses the next append instead of being replaced by it.
      await writeFile(join(root, `${compiled.digest}.publications.json`), '[{"digest":', 'utf8');
      await expect(appendReleasePublication(root, entry)).rejects.toThrow(/unreadable/);
      await expect(readReleasePublications(root, compiled.digest)).rejects.toThrow(/unreadable/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to write a file outside the bundle root', async () => {
    const compiled = compileFixture();
    compiled.files.push({ path: '../escaped.html', contents: 'x', hash: 'x', bytes: 1 });
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await expect(writeReleaseBundle(compiled, root)).rejects.toThrow(/escapes the release bundle root/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

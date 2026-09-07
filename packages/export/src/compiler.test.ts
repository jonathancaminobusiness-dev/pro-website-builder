import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { compileRelease, readBundleHashes, ReleaseVetoError, writeReleaseBundle, type CompiledSite } from './index.js';

const OPTIONS = { siteUrl: 'https://oficina.example', siteName: 'Oficina' };

function compileFixture(mutate?: (ir: DesignIR) => void): CompiledSite {
  const ir = createFixtureIR();
  mutate?.(ir);
  return compileRelease(renderDesign(ir), ir, OPTIONS);
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
    expect(stylesheet).toContain('[data-page-id="page-home"] [data-node-id="home-title"]{color:var(--color-ink);font-family:var(--type-display)}');
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

  it('refuses a site URL that is not an absolute origin', () => {
    const ir = createFixtureIR();
    expect(() => compileRelease(renderDesign(ir), ir, { ...OPTIONS, siteUrl: '/relative' })).toThrow(/absolute http\(s\) site URL/i);
  });
});

describe('release vetoes', () => {
  it('refuses to export an asset without a usable licence', async () => {
    const compiled = compileFixture((ir) => { ir.assets.items[0]!.provenance.license = '  '; });
    expect(compiled.vetoes.map((veto) => veto.id)).toContain('ASSET_WITHOUT_LICENSE');
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await expect(writeReleaseBundle(compiled, root, { approvedVersionId: 'v0' })).rejects.toBeInstanceOf(ReleaseVetoError);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats an unresolved licence placeholder as no licence at all', () => {
    const compiled = compileFixture((ir) => { ir.assets.items[0]!.provenance.license = 'pending provider terms'; });
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
      await expect(writeReleaseBundle(compiled, root, { approvedVersionId: 'v0' })).rejects.toThrow(/SECRET_IN_BUNDLE/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('vetoes an executable URL and an element the renderer never produces', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    rendered.routes[0]!.html = rendered.routes[0]!.html.replace('</body>', '<a href="javascript:alert(1)">x</a></body>');
    const compiled = compileRelease(rendered, ir, OPTIONS);
    const ids = compiled.vetoes.map((veto) => veto.id);
    expect(ids).toContain('XSS_OR_JAVASCRIPT_URL');
    expect(ids).toContain('UNSANITIZED_HTML');
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

  it('lists every asset, font and the toolchain in the licence inventory', () => {
    const compiled = compileFixture();
    const inventory = JSON.parse(fileText(compiled, 'licenses.json')) as Array<{ id: string }>;
    expect(inventory.map((entry) => entry.id)).toContain('fixture-mark');
    expect(inventory.map((entry) => entry.id)).toContain('toolchain:pro-website-builder');
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
      const manifestA = await writeReleaseBundle(first, rootA, { approvedVersionId: 'v-approved' });
      const manifestB = await writeReleaseBundle(second, rootB, { approvedVersionId: 'v-approved' });
      expect(manifestA.directory.endsWith(first.digest)).toBe(true);
      expect(await readBundleHashes(manifestA)).toEqual(await readBundleHashes(manifestB));
      expect({ ...manifestA, directory: '' }).toEqual({ ...manifestB, directory: '' });
      const raw = await readFile(join(manifestA.directory, 'manifest.json'), 'utf8');
      expect(raw).not.toMatch(/createdAt|timestamp/i);
      await stat(join(manifestA.directory, 'index.html'));
    } finally { await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); }
  });

  it('changes the digest when the document changes', () => {
    const base = compileFixture();
    const changed = compileFixture((ir) => { ir.pages.routes[0]!.title = 'Oficina — outra coisa'; });
    expect(changed.digest).not.toBe(base.digest);
  });

  it('refuses to rewrite an existing bundle with a different manifest', async () => {
    const compiled = compileFixture();
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await writeReleaseBundle(compiled, root, { approvedVersionId: 'v-alpha' });
      await expect(writeReleaseBundle(compiled, root, { approvedVersionId: 'v-beta' })).rejects.toThrow(/never rewritten/);
      const raw = await readFile(join(root, compiled.digest, 'manifest.json'), 'utf8');
      expect(JSON.parse(raw).approvedVersionId).toBe('v-alpha');
      await writeReleaseBundle(compiled, root, { approvedVersionId: 'v-alpha' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to write a file outside the bundle root', async () => {
    const compiled = compileFixture();
    compiled.files.push({ path: '../escaped.html', contents: 'x', hash: 'x', bytes: 1 });
    const root = await mkdtemp(join(tmpdir(), 'pwb-release-'));
    try {
      await expect(writeReleaseBundle(compiled, root, { approvedVersionId: 'v0' })).rejects.toThrow(/escapes the release bundle root/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

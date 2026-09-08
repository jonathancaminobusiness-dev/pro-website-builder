import type { ParityReport } from '@pwb/domain';
import { scanTags, type CompiledSite, type FontDecision } from '@pwb/export';
import type { RenderedDocument } from '@pwb/renderer';

interface DocumentView {
  title: string;
  lang: string;
  order: string[];
  styles: Map<string, string>;
  text: string;
  tags: string[];
}

function normalizeDeclarations(declarations: string): string {
  return declarations
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '')
    .sort()
    .join(';');
}

function decode(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function unescapeCss(value: string): string {
  return value.replaceAll(/\\(.)/g, '$1');
}

function textContent(html: string): string {
  const withoutHead = html.replace(/<head>[\s\S]*?<\/head>/i, '');
  return decode(withoutHead.replaceAll(/<[^>]*>/g, ' ')).replaceAll(/\s+/g, ' ').trim();
}

function documentSkeleton(html: string): Pick<DocumentView, 'title' | 'lang' | 'order' | 'text' | 'tags'> {
  const tags = scanTags(html);
  return {
    title: decode(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
    lang: tags.find((tag) => tag.name === 'html')?.attributes.find((attribute) => attribute.name === 'lang')?.value ?? '',
    order: tags.filter((tag) => !tag.closing).flatMap((tag) => { const id = tag.attributes.find((attribute) => attribute.name === 'data-node-id')?.value; return id === undefined ? [] : [decode(id)]; }),
    text: textContent(html),
    tags: tags.filter((tag) => !tag.closing).map((tag) => tag.name),
  };
}

/** The preview view: styles live in the `style` attribute the renderer emits. */
function previewView(html: string): DocumentView {
  const styles = new Map<string, string>();
  for (const tag of scanTags(html)) {
    if (tag.closing) continue;
    const id = tag.attributes.find((attribute) => attribute.name === 'data-node-id')?.value;
    const style = tag.attributes.find((attribute) => attribute.name === 'style')?.value;
    if (id === undefined || style === undefined) continue;
    styles.set(decode(id), normalizeDeclarations(decode(style)));
  }
  return { ...documentSkeleton(html), styles };
}

const NODE_RULE = /\[data-page-id="((?:[^"\\]|\\.)*)"\]\s*\[data-node-id="((?:[^"\\]|\\.)*)"\]\{([^}]*)\}/g;

/**
 * The release view: the same styles, read back out of the compiled stylesheet by
 * a parser that shares no code with the compiler that wrote it, so the check
 * cannot pass by agreeing with itself.
 */
function releaseView(html: string, stylesheet: string, pageId: string): DocumentView {
  const styles = new Map<string, string>();
  NODE_RULE.lastIndex = 0;
  for (let match = NODE_RULE.exec(stylesheet); match; match = NODE_RULE.exec(stylesheet)) {
    if (unescapeCss(match[1]!) !== pageId) continue;
    styles.set(unescapeCss(match[2]!), normalizeDeclarations(match[3]!));
  }
  return { ...documentSkeleton(html), styles };
}

function faceName(decision: FontDecision): string {
  return `${decision.family} ${decision.weight} ${decision.style}`;
}

/**
 * The faces the captain reviewed against the faces the release ships.
 *
 * A face file is content-addressed, so re-exporting one changes the path the
 * two sides name and this comparison says which face moved. It belongs to every
 * route because every route loads the same faces, and the stylesheet parsing
 * above never sees an `@font-face` rule: without this, a release rendered in a
 * typeface the captain never looked at still reports every route as identical.
 */
function compareFonts(preview: FontDecision[], release: FontDecision[]): string[] {
  const differences: string[] = [];
  const shipped = new Map(release.map((decision) => [faceName(decision), decision]));
  for (const decision of preview) {
    const other = shipped.get(faceName(decision));
    if (other === undefined) { differences.push(`A face ${faceName(decision)} está no preview e não no release.`); continue; }
    if (other.path !== decision.path) differences.push(`A face ${faceName(decision)} tem arquivos diferentes: preview ${decision.path ?? 'nenhum'}, release ${other.path ?? 'nenhum'}.`);
  }
  const reviewed = new Set(preview.map(faceName));
  for (const decision of release) {
    if (!reviewed.has(faceName(decision))) differences.push(`A face ${faceName(decision)} está no release e não no preview.`);
  }
  return differences;
}

function compare(route: string, preview: DocumentView, release: DocumentView): string[] {
  const differences: string[] = [];
  if (preview.title !== release.title) differences.push(`O título difere: preview ${JSON.stringify(preview.title)}, release ${JSON.stringify(release.title)}.`);
  if (preview.lang !== release.lang) differences.push(`O idioma do documento difere: preview ${preview.lang}, release ${release.lang}.`);
  if (preview.text !== release.text) differences.push('O texto visível difere entre preview e release.');
  if (preview.order.join('>') !== release.order.join('>')) differences.push('A ordem dos nós difere entre preview e release.');
  for (const [nodeId, declarations] of preview.styles) {
    const other = release.styles.get(nodeId);
    if (other === undefined) differences.push(`O nó ${nodeId} tem estilo no preview e nenhuma regra no release.`);
    else if (other !== declarations) differences.push(`O nó ${nodeId} resolve estilos diferentes: preview ${JSON.stringify(declarations)}, release ${JSON.stringify(other)}.`);
  }
  for (const nodeId of release.styles.keys()) {
    if (!preview.styles.has(nodeId)) differences.push(`O nó ${nodeId} tem regra no release e nenhum estilo no preview.`);
  }
  if (release.tags.includes('style')) differences.push(`A rota ${route} ainda embute uma folha de estilo no documento do release.`);
  return differences;
}

/**
 * Proves that the release renders the same document the captain reviewed in the
 * preview. Both views come from the same DesignIR through the same renderer;
 * only the delivery differs, and this check is what says so.
 *
 * `previewFaces` are the faces the preview origin actually served. They are
 * absent only when no preview served this document — a command line run — and
 * then the faces are the one thing this check cannot speak for.
 */
export function checkPreviewReleaseParity(rendered: RenderedDocument, compiled: CompiledSite, pageIdByRoute: Map<string, string>, previewFaces?: FontDecision[]): ParityReport {
  const stylesheet = compiled.files.find((file) => file.path === compiled.stylesheetPath);
  const css = typeof stylesheet?.contents === 'string' ? stylesheet.contents : '';
  const faces = previewFaces === undefined ? [] : compareFonts(previewFaces, compiled.fonts);
  const routes = rendered.routes.map((route) => {
    const differences = [...routeDifferences(route, compiled, css, pageIdByRoute), ...faces];
    return { route: route.route, matched: differences.length === 0, differences };
  });
  return { matched: routes.every((route) => route.matched), routes };
}

function routeDifferences(route: RenderedDocument['routes'][number], compiled: CompiledSite, css: string, pageIdByRoute: Map<string, string>): string[] {
  const compiledRoute = compiled.routes.find((candidate) => candidate.route === route.route);
  const file = compiledRoute ? compiled.files.find((candidate) => candidate.path === compiledRoute.path) : undefined;
  if (!compiledRoute || !file || typeof file.contents !== 'string') return [`A rota ${route.route} existe no preview e não no release.`];
  const pageId = pageIdByRoute.get(route.route);
  if (pageId === undefined) return [`A rota ${route.route} não tem página correspondente no documento.`];
  return compare(route.route, previewView(route.html), releaseView(file.contents, css, pageId));
}

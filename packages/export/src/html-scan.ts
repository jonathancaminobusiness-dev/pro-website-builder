/**
 * A strict scanner over renderer output.
 *
 * The renderer escapes `<`, `>` and `"` inside text and attribute values, so a
 * document it produced can be split into tags and text by looking for `<` and
 * the next `>`. The scanner refuses anything that does not match that shape;
 * a document the scanner cannot read is a build failure, never a guess.
 */

export interface ScannedAttribute { name: string; value: string; }
export interface ScannedTag {
  raw: string;
  start: number;
  end: number;
  name: string;
  closing: boolean;
  attributes: ScannedAttribute[];
}

const TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;

export class HtmlScanError extends Error {}

/** Every tag in the document, in source order. Declarations such as `<!doctype>` are skipped. */
export function scanTags(html: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    const close = html.indexOf('>', open);
    if (close === -1) throw new HtmlScanError(`Unterminated tag at offset ${open}.`);
    const raw = html.slice(open, close + 1);
    index = close + 1;
    if (raw.startsWith('<!')) continue;
    const nameMatch = TAG_NAME.exec(raw);
    if (!nameMatch) throw new HtmlScanError(`Tag at offset ${open} has no readable name.`);
    const attributes: ScannedAttribute[] = [];
    const body = raw.slice(nameMatch[0].length, raw.endsWith('/>') ? -2 : -1);
    ATTRIBUTE.lastIndex = 0;
    for (let match = ATTRIBUTE.exec(body); match; match = ATTRIBUTE.exec(body)) {
      attributes.push({ name: match[1]!.toLowerCase(), value: match[2] ?? '' });
    }
    tags.push({ raw, start: open, end: close + 1, name: nameMatch[1]!.toLowerCase(), closing: raw.startsWith('</'), attributes });
  }
  return tags;
}

export interface ExtractedStyle { pageId: string; nodeId: string; declarations: string; }
export interface StyleExtraction { html: string; styles: ExtractedStyle[]; }

function unescapeHtml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** Escapes a value for use inside a CSS attribute selector such as `[data-node-id="…"]`. */
export function cssAttributeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ');
}

/**
 * Moves every `style` attribute of the document into per-node rules so the
 * release can ship a `style-src 'self'` policy with no inline style allowance.
 * A node without a `data-node-id` cannot be addressed by a rule, so a style
 * attribute on one is a build failure rather than a silently dropped style.
 */
export function extractInlineStyles(html: string, pageId: string): StyleExtraction {
  const styles: ExtractedStyle[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const tag of scanTags(html)) {
    const style = tag.attributes.find((attribute) => attribute.name === 'style');
    if (!style) continue;
    const nodeId = tag.attributes.find((attribute) => attribute.name === 'data-node-id')?.value;
    if (nodeId === undefined) throw new HtmlScanError(`A <${tag.name}> element carries a style attribute without a data-node-id to address it.`);
    pieces.push(html.slice(cursor, tag.start), tag.raw.replace(` style="${style.value}"`, ''));
    cursor = tag.end;
    styles.push({ pageId, nodeId: unescapeHtml(nodeId), declarations: unescapeHtml(style.value) });
  }
  pieces.push(html.slice(cursor));
  const rewritten = pieces.join('');
  if (/ style="/.test(rewritten)) throw new HtmlScanError('The compiler could not remove every inline style attribute.');
  return { html: rewritten, styles };
}

/** The CSS rules that replace the inline styles of one page. */
export function styleRules(styles: ExtractedStyle[]): string {
  return styles
    .map((style) => `[data-page-id="${cssAttributeValue(style.pageId)}"] [data-node-id="${cssAttributeValue(style.nodeId)}"]{${style.declarations}}`)
    .join('\n');
}

/** Replaces `needle` exactly once, refusing any document where it is absent or repeated. */
export function replaceOnce(html: string, needle: string, replacement: string): string {
  const first = html.indexOf(needle);
  if (first === -1) throw new HtmlScanError(`The compiler expected to find ${JSON.stringify(needle.slice(0, 60))} in the rendered document.`);
  if (html.indexOf(needle, first + needle.length) !== -1) throw new HtmlScanError(`The compiler found ${JSON.stringify(needle.slice(0, 60))} more than once and will not guess which one to rewrite.`);
  return `${html.slice(0, first)}${replacement}${html.slice(first + needle.length)}`;
}

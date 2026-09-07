import { hashJson, resolveTokens, slotChildIds, type DesignIR, type Page } from '@pwb/domain';
import type { NodeGeometry, RenderContext, RenderEvidence } from './evidence.js';
import { lengthToPx } from './checks.js';

/**
 * Builds the evidence a capture with a clean runtime would produce for one context, with the geometry
 * derived from the resolved tokens so a spacing that leaves the grid rhythm still shows up as one.
 * Tests and the fake RenderHub use it so the deterministic gate can be exercised without a browser;
 * the real hub replaces every field with a measurement.
 */
export function createCleanEvidence(ir: DesignIR, context: RenderContext, screenshotPath = `memory://${context.route}`): RenderEvidence {
  const page = ir.pages.routes.find((candidate) => candidate.route === context.route);
  if (!page) throw new Error(`The document has no route ${context.route} to describe.`);
  const values = resolveTokens(ir.identity.tokens).values;
  const rhythmPath = /^\{([^}]+)\}$/.exec(ir.identity.gridGrammar.rhythmToken)?.[1];
  const rhythm = rhythmPath === undefined ? 16 : lengthToPx(values[rhythmPath] ?? 16) ?? 16;
  const parents = parentIndex(page);
  const px = (value: string | number | boolean | undefined): number | null => {
    const reference = typeof value === 'string' ? /^\{([^}]+)\}$/.exec(value) : null;
    if (!reference) return null;
    const resolved = values[reference[1]!];
    return resolved === undefined ? null : lengthToPx(resolved) ?? null;
  };
  const nodes: NodeGeometry[] = page.nodes.map((node, index) => {
    const parentNodeId = parents.get(node.id);
    return {
      nodeId: node.id,
      tag: node.kind === 'type' ? node.semantic : 'div',
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      box: { x: 0, y: index * rhythm, width: context.viewport, height: rhythm * 2 },
      clientWidth: context.viewport, clientHeight: rhythm * 2, scrollWidth: context.viewport, scrollHeight: rhythm * 2,
      overflowHidden: false, displayed: true, focusable: false, ellipsis: false,
      accessibleName: typeof node.props.text === 'string' ? node.props.text : '',
      text: typeof node.props.text === 'string' ? node.props.text : '',
      gapPx: px(node.props.gap),
      paddingBlockPx: px(node.props.paddingBlock ?? node.props.padding),
      paddingInlinePx: px(node.props.paddingInline ?? node.props.padding),
      marginBlockPx: px(node.props.margin),
    };
  });
  return {
    context,
    documentMetrics: { scrollWidth: context.viewport, clientWidth: context.viewport, scrollHeight: nodes.length * rhythm * 2, clientHeight: 900 },
    nodes,
    contrast: page.nodes.filter((node) => typeof node.props.text === 'string' && node.props.text !== '')
      .map((node) => ({ nodeId: node.id, foreground: '#000000', background: '#ffffff', fontSizePx: 16, bold: false })),
    focus: [],
    axeViolations: [],
    consoleErrors: [], networkErrors: [], stable: true,
    screenshotPath,
    domHash: hashJson([page.id, context]),
  };
}

function parentIndex(page: Page): Map<string, string> {
  const parents = new Map<string, string>();
  for (const node of page.nodes) for (const childId of slotChildIds(node)) parents.set(childId, node.id);
  return parents;
}

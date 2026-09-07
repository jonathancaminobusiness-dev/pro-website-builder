import { hashJson, resolveTokens, slotChildIds, type DesignIR, type Page } from '@pwb/domain';
import type { NodeGeometry, RenderContext, RenderEvidence } from './evidence.js';
import { lengthToPx } from './checks.js';

/**
 * Builds the evidence a clean capture would produce for one context, straight from the IR.
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
  const nodes: NodeGeometry[] = page.nodes.map((node, index) => {
    const parentNodeId = parents.get(node.id);
    const gap = typeof node.props.gap === 'string' ? rhythm : null;
    return {
      nodeId: node.id,
      tag: node.kind === 'type' ? node.semantic : 'div',
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      box: { x: 0, y: index * rhythm, width: context.viewport, height: rhythm * 2 },
      clientWidth: context.viewport, clientHeight: rhythm * 2, scrollWidth: context.viewport, scrollHeight: rhythm * 2,
      overflowHidden: false, displayed: true, focusable: false, ellipsis: false,
      accessibleName: typeof node.props.text === 'string' ? node.props.text : '',
      text: typeof node.props.text === 'string' ? node.props.text : '',
      gapPx: gap,
      paddingBlockPx: typeof node.props.padding === 'string' || typeof node.props.paddingBlock === 'string' ? rhythm : null,
      paddingInlinePx: typeof node.props.padding === 'string' || typeof node.props.paddingInline === 'string' ? rhythm : null,
      marginBlockPx: null,
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

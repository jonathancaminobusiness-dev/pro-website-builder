import type { ContrastSample, FocusSample, NodeGeometry } from '@pwb/qa-deterministic';

/**
 * Everything one page read reports. These functions are serialized into the browser by Playwright,
 * so each must be self-contained: no imports, no closure over module scope.
 */
export interface CollectedPage {
  documentMetrics: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
  nodes: NodeGeometry[];
  contrast: ContrastSample[];
  dom: string;
}

/** Applies a state fixture to the live document before the capture. */
export function applyRenderState(options: { hiddenNodeIds: string[]; state: string }): void {
  document.documentElement.dataset.state = options.state;
  for (const element of document.querySelectorAll<HTMLElement>('[data-node-id]')) element.hidden = false;
  for (const nodeId of options.hiddenNodeIds) {
    const element = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (element) element.hidden = true;
  }
}

export function collectRenderEvidence(): CollectedPage {
  const root = document.documentElement;

  const isOpaque = (color: string): boolean => {
    const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (!match) return color !== '' && color !== 'transparent';
    const alpha = match[1]!.split(/[,/\s]+/).filter(Boolean)[3];
    return alpha === undefined || Number.parseFloat(alpha) > 0;
  };

  const effectiveBackground = (element: Element): string => {
    let current: Element | null = element;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (isOpaque(color)) return color;
      current = current.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };

  const pixels = (value: string): number | null => {
    const amount = Number.parseFloat(value);
    return Number.isFinite(amount) ? amount : null;
  };

  const ownText = (element: Element): string => [...element.childNodes]
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.textContent ?? '')
    .join('')
    .trim();

  const focusableSelector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const elements = [...document.querySelectorAll<HTMLElement>('[data-node-id]')];
  const nodes: NodeGeometry[] = [];
  const contrast: ContrastSample[] = [];

  for (const element of elements) {
    const nodeId = element.dataset.nodeId ?? '';
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const parent = element.parentElement?.closest<HTMLElement>('[data-node-id]');
    const parentNodeId = parent?.dataset.nodeId;
    const displayed = style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden;
    const text = ownText(element);
    nodes.push({
      nodeId,
      tag: element.tagName.toLowerCase(),
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      overflowHidden: style.overflowX === 'hidden' || style.overflowY === 'hidden' || style.overflow === 'hidden',
      displayed,
      focusable: element.matches(focusableSelector),
      ellipsis: style.textOverflow === 'ellipsis',
      accessibleName: (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? '').trim(),
      text,
      gapPx: style.rowGap === 'normal' ? null : pixels(style.rowGap),
      paddingBlockPx: pixels(style.paddingTop),
      paddingInlinePx: pixels(style.paddingLeft),
      marginBlockPx: pixels(style.marginTop),
    });
    if (displayed && text !== '') {
      contrast.push({
        nodeId,
        foreground: style.color,
        background: effectiveBackground(element),
        fontSizePx: Number.parseFloat(style.fontSize) || 16,
        bold: Number.parseInt(style.fontWeight, 10) >= 700,
      });
    }
  }

  return {
    documentMetrics: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight },
    nodes,
    contrast,
    dom: root.outerHTML,
  };
}

/** Reads the focus indicator of whatever the keyboard just reached. */
export function readFocusSample(): FocusSample | null {
  const active = document.activeElement;
  if (!active || active === document.body || !(active instanceof HTMLElement)) return null;
  const owner = active.closest<HTMLElement>('[data-node-id]');
  const style = getComputedStyle(active);
  const backdrop = (): string => {
    let current: Element | null = active.parentElement;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
      const alpha = match ? match[1]!.split(/[,/\s]+/).filter(Boolean)[3] : undefined;
      if (match ? alpha === undefined || Number.parseFloat(alpha) > 0 : color !== '' && color !== 'transparent') return color;
      current = current.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };
  return {
    nodeId: owner?.dataset.nodeId ?? active.tagName.toLowerCase(),
    outlineWidthPx: Number.parseFloat(style.outlineWidth) || 0,
    outlineStyle: style.outlineStyle,
    outlineColor: style.outlineColor,
    surroundingColor: backdrop(),
    boxShadow: style.boxShadow === 'none' ? '' : style.boxShadow,
  };
}

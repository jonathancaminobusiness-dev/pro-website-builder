export interface Rgba { r: number; g: number; b: number; a: number; }

const named: Record<string, string> = { transparent: 'rgba(0,0,0,0)', white: '#ffffff', black: '#000000' };

/** Parses the colour notations a browser reports through `getComputedStyle`. */
export function parseColor(input: string): Rgba | undefined {
  const value = (named[input.trim().toLowerCase()] ?? input).trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const expand = (part: string): number => Number.parseInt(part.length === 1 ? part.repeat(2) : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      const parts = [...digits];
      return { r: expand(parts[0]!), g: expand(parts[1]!), b: expand(parts[2]!), a: parts[3] === undefined ? 1 : expand(parts[3]) / 255 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const pair = (index: number): number => expand(digits.slice(index, index + 2));
      return { r: pair(0), g: pair(2), b: pair(4), a: digits.length === 8 ? pair(6) / 255 : 1 };
    }
    return undefined;
  }
  const functional = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!functional) return undefined;
  const parts = functional[1]!.split(/[,/\s]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return undefined;
  const alpha = parts[3];
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: alpha === undefined || !Number.isFinite(alpha) ? 1 : alpha };
}

/** Flattens a translucent colour onto an opaque backdrop, the way a browser composites it. */
export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  const alpha = Math.min(Math.max(foreground.a, 0), 1);
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

/** WCAG 2.2 relative luminance. */
export function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const scaled = Math.min(Math.max(value, 0), 255) / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: string, background: string): number | undefined {
  const back = parseColor(background);
  const front = parseColor(foreground);
  if (!back || !front) return undefined;
  const opaqueBack = compositeOver(back, { r: 255, g: 255, b: 255, a: 1 });
  const opaqueFront = compositeOver(front, opaqueBack);
  const lighter = Math.max(relativeLuminance(opaqueFront), relativeLuminance(opaqueBack));
  const darker = Math.min(relativeLuminance(opaqueFront), relativeLuminance(opaqueBack));
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 AA thresholds: large text is at least 24px, or 18.66px when bold. */
export function requiredContrast(fontSizePx: number, bold: boolean): number {
  const large = fontSizePx >= 24 || (bold && fontSizePx >= 18.66);
  return large ? 3 : 4.5;
}

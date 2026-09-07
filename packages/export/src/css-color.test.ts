import { describe, expect, it } from 'vitest';
import { isFallbackFailure, needsColorFallback, srgbFallback, supportsConditionFor } from './css-color.js';

describe('sRGB fallbacks for modern colour syntax', () => {
  it('leaves values every browser already understands alone', () => {
    expect(needsColorFallback('#18252d')).toBe(false);
    expect(needsColorFallback('rgb(24 37 45)')).toBe(false);
    expect(needsColorFallback('hsl(200 30% 14%)')).toBe(false);
    expect(srgbFallback('#18252d')).toBeUndefined();
  });

  it('recognises the colour functions that need a companion declaration', () => {
    for (const value of ['oklch(70% 0.1 145)', 'oklab(0.7 0 0)', 'lab(50% 20 -30)', 'lch(50% 30 200)', 'color(display-p3 1 0 0)', 'color-mix(in oklab, red, blue)', 'light-dark(#fff, #000)']) {
      expect(needsColorFallback(value), value).toBe(true);
    }
  });

  it('converts the perceptual and CIE spaces to sRGB hex', () => {
    expect(srgbFallback('oklch(0% 0 0)')).toEqual({ hex: '#000000' });
    expect(srgbFallback('oklch(100% 0 0)')).toEqual({ hex: '#ffffff' });
    expect(srgbFallback('oklab(1 0 0)')).toEqual({ hex: '#ffffff' });
    expect(srgbFallback('lab(100% 0 0)')).toEqual({ hex: '#ffffff' });
    expect(srgbFallback('lab(0% 0 0)')).toEqual({ hex: '#000000' });
    expect(srgbFallback('lch(100% 0 0)')).toEqual({ hex: '#ffffff' });
    expect(srgbFallback('color(srgb 1 0 0)')).toEqual({ hex: '#ff0000' });
    expect(srgbFallback('color(srgb-linear 0 0 0)')).toEqual({ hex: '#000000' });
  });

  it('clips a wide-gamut colour into sRGB instead of dropping the token', () => {
    expect(srgbFallback('color(display-p3 1 0 0)')).toEqual({ hex: '#ff0000' });
  });

  it('keeps alpha by widening the hex', () => {
    expect(srgbFallback('oklch(0% 0 0 / 0.5)')).toEqual({ hex: '#00000080' });
  });

  it('reads a token whose hue carries an explicit angle unit', () => {
    expect(srgbFallback('oklch(60% 0.1 0.5turn)')).toEqual(srgbFallback('oklch(60% 0.1 180deg)'));
  });

  it('refuses the syntaxes it cannot convert deterministically instead of guessing', () => {
    for (const value of ['color-mix(in oklab, red 50%, blue)', 'light-dark(#ffffff, #000000)', 'oklch(from var(--x) l c h)', 'color(rec2020 1 0 0)']) {
      const result = srgbFallback(value);
      expect(isFallbackFailure(result), value).toBe(true);
    }
  });

  it('guards each value with a condition the browser can actually test', () => {
    expect(supportsConditionFor('oklch(70% 0.1 145)')).toBe('color: oklch(0% 0 0)');
    expect(supportsConditionFor('lab(50% 20 -30)')).toBe('color: lab(0% 0 0)');
    expect(supportsConditionFor('color(display-p3 1 0 0)')).toBe('color: color(srgb 0 0 0)');
  });
});

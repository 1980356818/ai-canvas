import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Apply alpha to a hex color.  Drop-in replacement for
 * `color-mix(in srgb, ${hex} P%, transparent)` that works on all
 * WebView2 versions (8-digit hex is Chrome 62+).
 */
export function hexAlpha(hex: string, alpha: number): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const h6 =
    h.length === 3
      ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
      : h;
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${h6}${a}`;
}

/**
 * Mix two hex colours in sRGB.  Drop-in replacement for
 * `color-mix(in srgb, ${c1} P%, ${c2})`.
 */
export function hexMix(c1: string, p: number, c2: string): string {
  const parse = (c: string) => {
    const h = c.startsWith("#") ? c.slice(1) : c;
    const h6 =
      h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
    return [
      parseInt(h6.slice(0, 2), 16),
      parseInt(h6.slice(2, 4), 16),
      parseInt(h6.slice(4, 6), 16),
    ] as const;
  };
  const [r1, g1, b1] = parse(c1);
  const [r2, g2, b2] = parse(c2);
  const t = p / 100;
  const mix = (a: number, b: number) =>
    Math.round(a * t + b * (1 - t))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`;
}

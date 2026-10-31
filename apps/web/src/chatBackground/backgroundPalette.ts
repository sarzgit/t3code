import "culori/css";
import { converter, formatHex } from "culori/fn";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

const toOklch = converter("oklch");

type Oklch = { readonly l: number; readonly c: number; readonly h: number };

export type BackgroundPalette = Readonly<{
  /** The colour covering the most of the image. */
  dominant: string;
  /** The most vivid colour that still covers a visible share, or null for muted images. */
  accent: string | null;
  /** The darkest and lightest colours covering a visible share; text must stay readable over them. */
  extremes: ReadonlyArray<string>;
}>;

// 4 bits per channel: coarse enough to group noise, fine enough to keep distinct hues apart.
const BUCKET_SHIFT = 4;
const MIN_ACCENT_SHARE = 0.005;
const MIN_EXTREME_SHARE = 0.02;
const MIN_ACCENT_CHROMA = 0.04;

export function pickBackgroundPalette(pixels: ArrayLike<number>): BackgroundPalette | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    const key =
      ((r >> BUCKET_SHIFT) << (2 * (8 - BUCKET_SHIFT))) |
      ((g >> BUCKET_SHIFT) << (8 - BUCKET_SHIFT)) |
      (b >> BUCKET_SHIFT);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
    total += 1;
  }
  if (total === 0) return null;

  const colors = [...buckets.values()].map((bucket) => {
    const hex = formatHex({
      mode: "rgb",
      r: bucket.r / bucket.count / 255,
      g: bucket.g / bucket.count / 255,
      b: bucket.b / bucket.count / 255,
    });
    return { hex, share: bucket.count / total, oklch: readOklch(hex) };
  });
  const dominant = colors.reduce((best, color) => (color.share > best.share ? color : best));

  // Prefer an accent that stands apart from the dominant hue; a one-hue image keeps its own.
  const candidates = colors.filter(
    (color) => color.share >= MIN_ACCENT_SHARE && color.oklch.c >= MIN_ACCENT_CHROMA,
  );
  const distinct = candidates.filter(
    (color) =>
      dominant.oklch.c < MIN_ACCENT_CHROMA || hueDistance(color.oklch, dominant.oklch) >= 30,
  );
  const pool = distinct.length > 0 ? distinct : candidates;
  const accent = pool.reduce<(typeof colors)[number] | null>(
    (best, color) => (!best || accentScore(color) > accentScore(best) ? color : best),
    null,
  );
  // Percentiles, not per-bucket shares, so a textured highlight spread over many buckets counts.
  const byLightness = colors.toSorted((first, second) => first.oklch.l - second.oklch.l);
  const extremes = [
    percentileColor(byLightness, MIN_EXTREME_SHARE),
    percentileColor(byLightness.toReversed(), MIN_EXTREME_SHARE),
  ];
  return { dominant: dominant.hex, accent: accent?.hex ?? null, extremes };
}

function percentileColor(
  ordered: ReadonlyArray<{ readonly hex: string; readonly share: number }>,
  share: number,
): string {
  let covered = 0;
  for (const color of ordered) {
    covered += color.share;
    if (covered >= share) return color.hex;
  }
  return ordered.at(-1)!.hex;
}

function accentScore(color: { readonly share: number; readonly oklch: Oklch }): number {
  return color.oklch.c * Math.sqrt(color.share);
}

function hueDistance(first: Oklch, second: Oklch): number {
  const distance = Math.abs(first.h - second.h) % 360;
  return distance > 180 ? 360 - distance : distance;
}

function readOklch(value: string): Oklch {
  const color = toOklch(value);
  return { l: color?.l ?? 0.5, c: color?.c ?? 0, h: color?.h ?? 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function oklchHex(color: Oklch): string {
  return formatHex({ mode: "oklch", l: color.l, c: color.c, h: color.h });
}

/** Canvas and accent seeds for one appearance, pushed far enough from mid-grey that text stays readable. */
export function backgroundThemeSeeds(
  palette: BackgroundPalette,
  appearance: ThemeAppearance,
): Readonly<{ canvas: string; accent: string }> {
  const dominant = readOklch(palette.dominant);
  const accent = palette.accent ? readOklch(palette.accent) : null;
  const dark = appearance === "dark";
  const canvas: Oklch = {
    l: dark ? clamp(dominant.l, 0.14, 0.22) : clamp(dominant.l, 0.95, 0.98),
    c: Math.min(dominant.c, dark ? 0.05 : 0.025),
    h: dominant.h,
  };
  const accentSeed: Oklch = accent
    ? {
        l: dark ? clamp(accent.l, 0.62, 0.8) : clamp(accent.l, 0.45, 0.62),
        c: Math.min(accent.c, 0.2),
        h: accent.h,
      }
    : { l: dark ? 0.7 : 0.5, c: Math.min(dominant.c, 0.06), h: dominant.h };
  return { canvas: oklchHex(canvas), accent: oklchHex(accentSeed) };
}

import { describe, expect, it } from "vite-plus/test";
import "culori/css";
import { converter } from "culori/fn";

import { pickBackgroundPalette } from "./backgroundPalette";

const toOklch = converter("oklch");

function pixels(...regions: ReadonlyArray<readonly [count: number, rgba: readonly number[]]>) {
  return Uint8ClampedArray.from(regions.flatMap(([count, rgba]) => Array(count).fill(rgba).flat()));
}

describe("pickBackgroundPalette", () => {
  it("takes the largest area as dominant and the vivid area as accent", () => {
    const palette = pickBackgroundPalette(
      pixels([700, [20, 40, 90, 255]], [200, [128, 128, 128, 255]], [100, [240, 140, 40, 255]]),
    );
    expect(palette?.dominant).toBe("#14285a");
    expect(toOklch(palette!.accent!)?.h).toBeCloseTo(toOklch("#f08c28")!.h!, 0);
  });

  it("uses the dominant hue as accent when the image has no other", () => {
    const palette = pickBackgroundPalette(
      pixels([700, [20, 40, 90, 255]], [300, [60, 120, 230, 255]]),
    );
    expect(palette?.accent).toBe("#3c78e6");
  });

  it("has no accent for a greyscale image", () => {
    const palette = pickBackgroundPalette(
      pixels([500, [30, 30, 30, 255]], [500, [200, 200, 200, 255]]),
    );
    expect(palette?.accent).toBeNull();
  });

  it("ignores a vivid speck too small to see", () => {
    const palette = pickBackgroundPalette(pixels([999, [30, 30, 30, 255]], [1, [255, 0, 0, 255]]));
    expect(palette?.accent).toBeNull();
  });

  it("ignores transparent pixels and returns null when nothing is visible", () => {
    expect(pickBackgroundPalette(pixels([100, [255, 0, 0, 0]]))).toBeNull();
    const palette = pickBackgroundPalette(pixels([900, [255, 0, 0, 0]], [100, [20, 40, 90, 255]]));
    expect(palette?.dominant).toBe("#14285a");
  });
});

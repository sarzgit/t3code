import { describe, expect, it } from "vite-plus/test";
import "culori/css";
import { converter, wcagContrast } from "culori/fn";

import { getThemeColorsForMode } from "../themePalette";
import { pickBackgroundPalette } from "./backgroundPalette";
import {
  CHAT_BACKGROUND_THEME_ID,
  backgroundRemovalRestore,
  backgroundVeilOpacities,
  buildBackgroundTheme,
} from "./chatBackground";

const toOklch = converter("oklch");

describe("buildBackgroundTheme", () => {
  it.each([
    ["a bright image", { dominant: "#f2f0e6", accent: "#2a7de1", extremes: [] }],
    ["a mid-grey image", { dominant: "#808080", accent: null, extremes: [] }],
    ["a dark image", { dominant: "#0b0d12", accent: "#e8b923", extremes: [] }],
  ])("keeps text readable in both modes for %s", (_name, palette) => {
    const theme = buildBackgroundTheme(palette);
    const dark = theme.colors;
    const light = theme.variants!.light!;
    expect(toOklch(dark.canvas)!.l).toBeLessThan(0.3);
    expect(toOklch(light.canvas)!.l).toBeGreaterThan(0.9);
    expect(wcagContrast(dark.text, dark.canvas)).toBeGreaterThanOrEqual(7);
    expect(wcagContrast(light.text, light.canvas)).toBeGreaterThanOrEqual(7);
  });

  it("carries the image's accent hue into the theme accent", () => {
    const theme = buildBackgroundTheme({ dominant: "#142a5a", accent: "#f08c28", extremes: [] });
    expect(toOklch(theme.colors.accent)!.h).toBeCloseTo(toOklch("#f08c28")!.h!, -1);
  });
});

describe("backgroundVeilOpacities", () => {
  const toRgb = converter("rgb");
  function composite(canvas: string, image: string, veil: number) {
    const top = toRgb(canvas)!;
    const bottom = toRgb(image)!;
    return {
      mode: "rgb" as const,
      r: top.r * veil + bottom.r * (1 - veil),
      g: top.g * veil + bottom.g * (1 - veil),
      b: top.b * veil + bottom.b * (1 - veil),
    };
  }

  it.each([
    ["a black image in light mode", "#000000", "light"],
    ["a white image in dark mode", "#ffffff", "dark"],
    ["a saturated image in dark mode", "#f08c28", "dark"],
  ] as const)("keeps body and muted text readable over %s", (_name, dominant, mode) => {
    const palette = { dominant, accent: null, extremes: [] };
    const veil = backgroundVeilOpacities(palette)[mode];
    const colors = getThemeColorsForMode(buildBackgroundTheme(palette), mode)!;
    const mixed = composite(colors.canvas, dominant, veil);
    expect(wcagContrast(colors.text, mixed)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(colors.textMuted, mixed)).toBeGreaterThanOrEqual(3);
  });

  it("keeps text readable over the lightest part of a mostly dark image", () => {
    const pixels = Uint8ClampedArray.from([
      ...Array(60).fill([0, 0, 0, 255]).flat(),
      ...Array(40).fill([255, 255, 255, 255]).flat(),
    ]);
    const palette = pickBackgroundPalette(pixels)!;
    const veil = backgroundVeilOpacities(palette).dark;
    const colors = getThemeColorsForMode(buildBackgroundTheme(palette), "dark")!;
    const overWhite = composite(colors.canvas, "#ffffff", veil);
    expect(wcagContrast(colors.text, overWhite)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(colors.textMuted, overWhite)).toBeGreaterThanOrEqual(3);
  });

  it("lets more of the image through when it already suits the mode", () => {
    const veils = backgroundVeilOpacities({ dominant: "#0b0d12", accent: null, extremes: [] });
    expect(veils.dark).toBeLessThan(veils.light);
  });
});

describe("backgroundRemovalRestore", () => {
  const previous = { previousTheme: "ocean", previousThemeHalves: null };

  it("restores the earlier theme when the background theme is active", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: CHAT_BACKGROUND_THEME_ID,
        currentHalves: {},
        ...previous,
      }),
    ).toEqual({ theme: "ocean", halves: null });
  });

  it("restores an earlier light/dark mix", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: CHAT_BACKGROUND_THEME_ID,
        currentHalves: {},
        previousTheme: "system",
        previousThemeHalves: '{"light":"ember","dark":"grove"}',
      }),
    ).toEqual({ theme: "system", halves: '{"light":"ember","dark":"grove"}' });
  });

  it("keeps a standard light theme picked beside a background dark half", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: "system",
        currentHalves: { dark: CHAT_BACKGROUND_THEME_ID },
        ...previous,
      }),
    ).toEqual({ theme: "system", halves: '{"dark":"ocean"}' });
  });

  it("restores each background half from that mode's earlier theme", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: "ocean",
        currentHalves: { light: CHAT_BACKGROUND_THEME_ID },
        previousTheme: "system",
        previousThemeHalves: '{"light":"iris"}',
      }),
    ).toEqual({ theme: "system", halves: '{"light":"iris","dark":"ocean"}' });
  });

  it("keeps a theme picked after the background was set", () => {
    expect(
      backgroundRemovalRestore({ currentTheme: "grove", currentHalves: {}, ...previous }),
    ).toBeNull();
  });

  it("keeps light and dark themes picked after the background was set", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: CHAT_BACKGROUND_THEME_ID,
        currentHalves: { light: "ember", dark: "grove" },
        ...previous,
      }),
    ).toBeNull();
  });

  it("restores only the mode still showing the background", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: CHAT_BACKGROUND_THEME_ID,
        currentHalves: { light: "ember" },
        previousTheme: "system",
        previousThemeHalves: '{"light":"iris","dark":"grove"}',
      }),
    ).toEqual({ theme: "system", halves: '{"light":"ember","dark":"grove"}' });
  });

  it("falls back to the system theme without a usable earlier theme", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: CHAT_BACKGROUND_THEME_ID,
        currentHalves: {},
        previousTheme: CHAT_BACKGROUND_THEME_ID,
        previousThemeHalves: null,
      }),
    ).toEqual({ theme: "system", halves: null });
  });
});

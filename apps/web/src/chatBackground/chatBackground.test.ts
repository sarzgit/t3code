import { describe, expect, it } from "vite-plus/test";
import "culori/css";
import { converter, wcagContrast } from "culori/fn";

import {
  CHAT_BACKGROUND_THEME_ID,
  backgroundRemovalRestore,
  buildBackgroundTheme,
} from "./chatBackground";

const toOklch = converter("oklch");

describe("buildBackgroundTheme", () => {
  it.each([
    ["a bright image", { dominant: "#f2f0e6", accent: "#2a7de1" }],
    ["a mid-grey image", { dominant: "#808080", accent: null }],
    ["a dark image", { dominant: "#0b0d12", accent: "#e8b923" }],
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
    const theme = buildBackgroundTheme({ dominant: "#142a5a", accent: "#f08c28" });
    expect(toOklch(theme.colors.accent)!.h).toBeCloseTo(toOklch("#f08c28")!.h!, -1);
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

  it("restores when the background theme is only one half of a mix", () => {
    expect(
      backgroundRemovalRestore({
        currentTheme: "system",
        currentHalves: { dark: CHAT_BACKGROUND_THEME_ID },
        ...previous,
      }),
    ).toEqual({ theme: "ocean", halves: null });
  });

  it("keeps a theme picked after the background was set", () => {
    expect(
      backgroundRemovalRestore({ currentTheme: "grove", currentHalves: {}, ...previous }),
    ).toBeNull();
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

import "culori/css";
import { useSyncExternalStore } from "react";
import { converter, wcagContrast } from "culori/fn";
import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "@t3tools/shared/themePalettes";

import { readThemeHalvesRaw, readThemePreference, refreshTheme, setTheme } from "../hooks/useTheme";
import {
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  isHeicImageFile,
  prepareImageForAttachment,
} from "../lib/imageCompression";
import {
  THEME_HALVES_STORAGE_KEY,
  createVividThemeColors,
  getCustomThemes,
  getThemeColorsForMode,
  installCustomTheme,
  removeCustomTheme,
  updateCustomTheme,
} from "../themePalette";
import {
  backgroundThemeSeeds,
  pickBackgroundPalette,
  type BackgroundPalette,
} from "./backgroundPalette";
import {
  deleteChatBackground,
  readChatBackground,
  writeChatBackground,
  type ChatBackgroundRecord,
} from "./backgroundStore";

export const CHAT_BACKGROUND_THEME_ID = "chat-background";
// Theme ids derive from names, so "Chat Background" collides; the collection marks ours.
const CHAT_BACKGROUND_COLLECTION = { id: "t3code.chat-background", label: "Background" };
const MAX_IMAGE_EDGE = 2560;
const PALETTE_SAMPLE_EDGE = 64;
const THEME_MODES = ["light", "dark"] as const;

type ChatBackgroundSnapshot = Readonly<{
  imageUrl: string | null;
  veil: Readonly<Record<ThemeAppearance, number>> | null;
}>;

const EMPTY_SNAPSHOT: ChatBackgroundSnapshot = { imageUrl: null, veil: null };
let snapshot = EMPTY_SNAPSHOT;
// Bumped by every publish so a slower load can't overwrite a newer set or remove.
let generation = 0;
let started = false;
const listeners = new Set<() => void>();
const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("t3code:chat-background");

function publish(record: Pick<ChatBackgroundRecord, "image" | "palette"> | null) {
  generation += 1;
  if (snapshot.imageUrl) URL.revokeObjectURL(snapshot.imageUrl);
  snapshot = record
    ? {
        imageUrl: URL.createObjectURL(record.image),
        veil: backgroundVeilOpacities(record.palette),
      }
    : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

function reload() {
  const startedAt = generation;
  readChatBackground()
    .then((record) => {
      if (generation === startedAt) publish(record);
    })
    .catch((error: unknown) => console.error("Failed to load the chat background.", error));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    channel?.addEventListener("message", reload);
    reload();
  }
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY_SNAPSHOT;

export function useChatBackground(): ChatBackgroundSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

async function prepareBackgroundImage(
  file: File,
): Promise<{ image: Blob; palette: BackgroundPalette }> {
  let source: Blob = file;
  if (isHeicImageFile(file)) {
    const converted = await prepareImageForAttachment(file, MAX_COMPRESSIBLE_SOURCE_BYTES);
    if (!converted.ok) throw new Error("That HEIC image couldn't be read.");
    source = converted.file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("That file isn't an image T3 Code can read.");
  }
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable.");

    const sampleScale = Math.min(1, PALETTE_SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * sampleScale));
    canvas.height = Math.max(1, Math.round(bitmap.height * sampleScale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const palette = pickBackgroundPalette(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    if (!palette) throw new Error("That image is fully transparent.");

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image =
      (await canvasToBlob(canvas, "image/webp", 0.85)) ??
      (await canvasToBlob(canvas, "image/jpeg", 0.85));
    if (!image) throw new Error("That image couldn't be resized.");
    return { image, palette };
  } finally {
    bitmap.close();
  }
}

export function buildBackgroundTheme(palette: BackgroundPalette): ThemeDefinition {
  const dark = backgroundThemeSeeds(palette, "dark");
  const light = backgroundThemeSeeds(palette, "light");
  return {
    id: CHAT_BACKGROUND_THEME_ID,
    label: "Background",
    appearance: "dark",
    colors: createVividThemeColors("dark", dark.canvas, dark.accent),
    variants: { light: createVividThemeColors("light", light.canvas, light.accent) },
    collection: CHAT_BACKGROUND_COLLECTION,
  };
}

function findBackgroundTheme(): { readonly owned: boolean; readonly label: string } | null {
  const theme = getCustomThemes().find((candidate) => candidate.id === CHAT_BACKGROUND_THEME_ID);
  if (!theme) return null;
  return { owned: theme.collection?.id === CHAT_BACKGROUND_COLLECTION.id, label: theme.label };
}

/** Throws a user-facing error when the file can't become a background. */
export async function setChatBackground(file: File): Promise<void> {
  const { image, palette } = await prepareBackgroundImage(file);
  const current = findBackgroundTheme();
  if (current && !current.owned) {
    throw new Error(`Rename your “${current.label}” theme first; its name is reserved.`);
  }
  const existing = await readChatBackground();
  const record: ChatBackgroundRecord = existing
    ? // Replacing an image keeps the selection from before the first background.
      { ...existing, image, palette }
    : {
        image,
        palette,
        previousTheme: readThemePreference(),
        previousThemeHalves: serializeThemeHalves(readThemeHalvesRaw()),
      };

  const theme = buildBackgroundTheme(palette);
  const replaced = getCustomThemes().find((candidate) => candidate.id === theme.id);
  if (replaced) updateCustomTheme(theme);
  else installCustomTheme(theme);
  try {
    await writeChatBackground(record);
  } catch (error) {
    if (replaced) updateCustomTheme(replaced);
    else removeCustomTheme(theme.id);
    throw new Error("The image couldn't be saved.", { cause: error });
  }
  publish(record);
  channel?.postMessage("changed");

  if (readThemePreference() === theme.id) refreshTheme();
  else if (!setTheme(theme.id)) {
    throw new Error("The image was saved, but the Background theme couldn't be selected.");
  }
}

export async function removeChatBackground(): Promise<void> {
  const record = await readChatBackground();
  const restore = backgroundRemovalRestore({
    currentTheme: readThemePreference(),
    currentHalves: readThemeHalvesRaw(),
    previousTheme: record?.previousTheme ?? null,
    previousThemeHalves: record?.previousThemeHalves ?? null,
  });
  if (restore) {
    const before = {
      theme: readThemePreference(),
      halves: serializeThemeHalves(readThemeHalvesRaw()),
    };
    if (!applyThemeSelection(restore)) {
      // setTheme clears the mix first, so put the whole selection back.
      applyThemeSelection(before);
      throw new Error("Your earlier theme couldn't be restored.");
    }
  }
  if (findBackgroundTheme()?.owned) removeCustomTheme(CHAT_BACKGROUND_THEME_ID);
  await deleteChatBackground();
  publish(null);
  channel?.postMessage("changed");
}

function applyThemeSelection(selection: {
  readonly theme: string;
  readonly halves: string | null;
}): boolean {
  if (!setTheme(selection.theme)) return false;
  if (selection.halves === null) return true;
  try {
    window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, selection.halves);
  } catch {
    return false;
  }
  refreshTheme();
  return true;
}

type ThemeHalves = { light?: string; dark?: string };

function serializeThemeHalves(halves: ThemeHalves): string | null {
  return halves.light === undefined && halves.dark === undefined ? null : JSON.stringify(halves);
}

function parseThemeHalves(raw: string | null): ThemeHalves {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return {};
    const halves = value as Record<string, unknown>;
    return {
      ...(typeof halves.light === "string" ? { light: halves.light } : {}),
      ...(typeof halves.dark === "string" ? { dark: halves.dark } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * What to switch to when the background is removed. Only modes still showing the generated
 * theme go back to the earlier selection; a theme picked since then stays.
 */
export function backgroundRemovalRestore(input: {
  readonly currentTheme: string;
  readonly currentHalves: ThemeHalves;
  readonly previousTheme: string | null;
  readonly previousThemeHalves: string | null;
}): { readonly theme: string; readonly halves: string | null } | null {
  const usesBackground = THEME_MODES.some(
    (mode) => (input.currentHalves[mode] ?? input.currentTheme) === CHAT_BACKGROUND_THEME_ID,
  );
  if (!usesBackground) return null;

  const previousHalves = parseThemeHalves(input.previousThemeHalves);
  const previousFor = (mode: ThemeAppearance) => {
    const previous = previousHalves[mode] ?? input.previousTheme;
    return previous === null || previous === CHAT_BACKGROUND_THEME_ID ? "system" : previous;
  };
  const wanted = Object.fromEntries(
    THEME_MODES.map((mode) => {
      const current = input.currentHalves[mode] ?? input.currentTheme;
      return [mode, current === CHAT_BACKGROUND_THEME_ID ? previousFor(mode) : current];
    }),
  ) as Record<ThemeAppearance, string>;

  if (wanted.light === wanted.dark) return { theme: wanted.light, halves: null };
  // A mix is a standard base with a theme per mode; standard picks need no half.
  const standardBase = [input.previousTheme, input.currentTheme].find(isStandardTheme) ?? "system";
  const halves: ThemeHalves = {};
  for (const mode of THEME_MODES) {
    if (!isStandardTheme(wanted[mode])) halves[mode] = wanted[mode];
  }
  return { theme: standardBase, halves: serializeThemeHalves(halves) };
}

function isStandardTheme(theme: string | null): theme is string {
  return theme === "system" || theme === "light" || theme === "dark";
}

const toRgb = converter("rgb");
const MIN_VEIL = 0.35;
const MAX_VEIL = 0.92;

function veilFor(colors: ThemeColors, samples: ReadonlyArray<string>): number {
  const canvas = toRgb(colors.canvas);
  if (!canvas) return MAX_VEIL;
  for (let veil = MIN_VEIL; veil < MAX_VEIL; veil += 0.01) {
    const readable = samples.every((sample) => {
      const image = toRgb(sample);
      if (!image) return false;
      // Alpha compositing happens in gamma-encoded sRGB, like the browser does.
      const mixed = {
        mode: "rgb" as const,
        r: canvas.r * veil + image.r * (1 - veil),
        g: canvas.g * veil + image.g * (1 - veil),
        b: canvas.b * veil + image.b * (1 - veil),
      };
      return wcagContrast(colors.text, mixed) >= 4.5 && wcagContrast(colors.textMuted, mixed) >= 3;
    });
    if (readable) return Math.round(veil * 100) / 100;
  }
  return MAX_VEIL;
}

/** The lightest tint over the image that keeps body and muted text readable on its visible colours. */
export function backgroundVeilOpacities(
  palette: BackgroundPalette,
): Readonly<Record<ThemeAppearance, number>> {
  const theme = buildBackgroundTheme(palette);
  const samples = [
    palette.dominant,
    ...(palette.accent ? [palette.accent] : []),
    ...palette.extremes,
  ];
  const veil = (mode: ThemeAppearance) => {
    const colors = getThemeColorsForMode(theme, mode);
    return colors ? veilFor(colors, samples) : MAX_VEIL;
  };
  return { light: veil("light"), dark: veil("dark") };
}

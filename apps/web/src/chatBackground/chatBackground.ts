import { useSyncExternalStore } from "react";
import type { ThemeDefinition } from "@t3tools/shared/themePalettes";

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
const MAX_IMAGE_EDGE = 2560;
const PALETTE_SAMPLE_EDGE = 64;

type ChatBackgroundSnapshot = Readonly<{ imageUrl: string | null }>;

let snapshot: ChatBackgroundSnapshot = { imageUrl: null };
let loadStarted = false;
const listeners = new Set<() => void>();

function publish(image: Blob | null) {
  if (snapshot.imageUrl) URL.revokeObjectURL(snapshot.imageUrl);
  snapshot = { imageUrl: image ? URL.createObjectURL(image) : null };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loadStarted) {
    loadStarted = true;
    readChatBackground()
      .then((record) => {
        if (record && snapshot.imageUrl === null) publish(record.image);
      })
      .catch((error: unknown) => console.error("Failed to load the chat background.", error));
  }
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;
const getServerSnapshot = (): ChatBackgroundSnapshot => ({ imageUrl: null });

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
  };
}

/** Throws a user-facing error when the file can't become a background. */
export async function setChatBackground(file: File): Promise<void> {
  const { image, palette } = await prepareBackgroundImage(file);
  const existing = await readChatBackground();
  const record: ChatBackgroundRecord = {
    image,
    palette,
    // Replacing an image keeps the theme from before the first background.
    previousTheme: existing?.previousTheme ?? readThemePreference(),
    previousThemeHalves:
      existing?.previousThemeHalves ?? serializeThemeHalves(readThemeHalvesRaw()),
  };
  await writeChatBackground(record);

  const theme = buildBackgroundTheme(palette);
  const installed = getCustomThemes().some((candidate) => candidate.id === theme.id);
  if (installed) updateCustomTheme(theme);
  else installCustomTheme(theme);
  if (readThemePreference() === theme.id) refreshTheme();
  else setTheme(theme.id);
  publish(image);
}

export async function removeChatBackground(): Promise<void> {
  const record = await readChatBackground();
  await deleteChatBackground();
  const restore = backgroundRemovalRestore({
    currentTheme: readThemePreference(),
    currentHalves: readThemeHalvesRaw(),
    previousTheme: record?.previousTheme ?? null,
    previousThemeHalves: record?.previousThemeHalves ?? null,
  });
  if (restore) {
    setTheme(restore.theme);
    if (restore.halves !== null) {
      window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, restore.halves);
      refreshTheme();
    }
  }
  removeCustomTheme(CHAT_BACKGROUND_THEME_ID);
  publish(null);
}

function serializeThemeHalves(halves: { light?: string; dark?: string }): string | null {
  return halves.light === undefined && halves.dark === undefined ? null : JSON.stringify(halves);
}

/**
 * What to switch back to when the background is removed. A theme the user picked after
 * setting the background stays; only the generated theme is undone.
 */
export function backgroundRemovalRestore(input: {
  readonly currentTheme: string;
  readonly currentHalves: { readonly light?: string; readonly dark?: string };
  readonly previousTheme: string | null;
  readonly previousThemeHalves: string | null;
}): { readonly theme: string; readonly halves: string | null } | null {
  const usesBackground =
    input.currentTheme === CHAT_BACKGROUND_THEME_ID ||
    input.currentHalves.light === CHAT_BACKGROUND_THEME_ID ||
    input.currentHalves.dark === CHAT_BACKGROUND_THEME_ID;
  if (!usesBackground) return null;
  if (input.previousTheme === null || input.previousTheme === CHAT_BACKGROUND_THEME_ID) {
    return { theme: "system", halves: null };
  }
  return { theme: input.previousTheme, halves: input.previousThemeHalves };
}

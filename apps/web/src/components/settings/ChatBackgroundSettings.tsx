import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CHAT_BACKGROUND_BLUR,
  MIN_CHAT_BACKGROUND_BLUR,
} from "@t3tools/contracts/settings";

import {
  removeChatBackground,
  setChatBackground,
  useChatBackground,
} from "../../chatBackground/chatBackground";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

async function runReportingFailure(action: () => Promise<void>, failureTitle: string) {
  try {
    await action();
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "Try again.",
      }),
    );
  }
}

export function ChatBackgroundSettings() {
  const { imageUrl } = useChatBackground();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>, failureTitle: string) => {
    setBusy(true);
    void runReportingFailure(action, failureTitle).then(() => setBusy(false));
  };

  const blurRatio =
    (settings.chatBackgroundBlur - MIN_CHAT_BACKGROUND_BLUR) /
    (MAX_CHAT_BACKGROUND_BLUR - MIN_CHAT_BACKGROUND_BLUR);
  const blurSliderStyle = {
    "--settings-slider-progress": `${blurRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - blurRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsSection id="appearance-background" title="Background">
      <SettingsRow
        {...searchableSetting("chat-background-image")}
        description="Shown behind the chat. The app's colours are taken from the image."
        control={
          <div className="flex items-center gap-2">
            {imageUrl ? (
              <img alt="" className="h-8 w-12 rounded-md object-cover" src={imageUrl} />
            ) : null}
            <input
              accept="image/*,.heic,.heif"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) run(() => setChatBackground(file), "Couldn’t use that image");
              }}
              ref={inputRef}
              type="file"
            />
            <Button
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              {imageUrl ? "Replace" : "Choose image…"}
            </Button>
            {imageUrl ? (
              <Button
                disabled={busy}
                onClick={() => run(removeChatBackground, "Couldn’t remove the background")}
                size="sm"
                variant="ghost-destructive"
              >
                Remove
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("setting-chat-background-blur")}
        resetAction={
          settings.chatBackgroundBlur !== DEFAULT_UNIFIED_SETTINGS.chatBackgroundBlur ? (
            <SettingResetButton
              label="background blur"
              onClick={() =>
                updateSettings({
                  chatBackgroundBlur: DEFAULT_UNIFIED_SETTINGS.chatBackgroundBlur,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="chat-background-blur"
            >
              {settings.chatBackgroundBlur}px
            </output>
            <input
              aria-label="Background blur"
              className="settings-slider min-w-0 flex-1"
              disabled={!imageUrl}
              id="chat-background-blur"
              max={MAX_CHAT_BACKGROUND_BLUR}
              min={MIN_CHAT_BACKGROUND_BLUR}
              onChange={(event) => {
                const chatBackgroundBlur = Number(event.currentTarget.value);
                if (
                  Number.isInteger(chatBackgroundBlur) &&
                  chatBackgroundBlur >= MIN_CHAT_BACKGROUND_BLUR &&
                  chatBackgroundBlur <= MAX_CHAT_BACKGROUND_BLUR
                ) {
                  updateSettings({ chatBackgroundBlur });
                }
              }}
              step={2}
              style={blurSliderStyle}
              type="range"
              value={settings.chatBackgroundBlur}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

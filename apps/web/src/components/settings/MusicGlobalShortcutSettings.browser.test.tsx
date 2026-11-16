import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type ClientSettings,
  type DesktopBridge,
  type KeybindingShortcut,
  type MusicGlobalShortcutStatus,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { MusicGlobalShortcutSettings } from "./MusicGlobalShortcutSettings";

vi.mock(import("../../state/music"), async (original) => ({
  ...(await original()),
  useMusicEnvironmentId: () => EnvironmentId.make("env-music"),
}));

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([{ key: "ctrl+alt+n", command: "thread.next" }]),
    ),
  };
});

const chord = (key: string, modifiers: Partial<KeybindingShortcut> = {}): KeybindingShortcut => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
  ...modifiers,
});

function setup(
  options: {
    readonly status?: MusicGlobalShortcutStatus;
    /** What the shell holds once it takes the keys back after recording. */
    readonly afterRelease?: MusicGlobalShortcutStatus;
    readonly release?: Promise<void>;
  } = {},
) {
  const saved: ClientSettings[] = [];
  const recording: boolean[] = [];
  let status: MusicGlobalShortcutStatus = options.status ?? { playPause: "unavailable" };
  let keysReleased = false;
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotShortcut: chord("2", { metaKey: true, shiftKey: true }),
    musicGlobalShortcuts: {
      enabled: true,
      bindings: { playPause: chord("p", { ctrlKey: true, altKey: true }) },
    },
  });
  const bridge = {
    getClientSettings: async () => saved.at(-1) ?? null,
    setClientSettings: async (settings: ClientSettings) => {
      saved.push(settings);
      status = {};
    },
    musicGlobalShortcuts: {
      // Like the shell: no keys are held while a recorder is open.
      getStatus: async () => (keysReleased ? {} : status),
      setRecording: async (value: boolean) => {
        recording.push(value);
        if (value) {
          keysReleased = true;
          return {};
        }
        await options.release;
        keysReleased = false;
        if (options.afterRelease !== undefined) status = options.afterRelease;
        return status;
      },
      onAction: () => () => undefined,
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: bridge as unknown as DesktopBridge,
  });
  return {
    saved,
    recording,
    [Symbol.dispose]: () => {
      Reflect.deleteProperty(window, "desktopBridge");
      __resetClientSettingsPersistenceForTests();
    },
  };
}

it("shows what the shell holds only after it has taken the keys back", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let releaseKeys = () => {};
  const release = new Promise<void>((resolve) => {
    releaseKeys = resolve;
  });
  using shell = setup({
    status: {},
    afterRelease: { playPause: "registered", next: "unavailable" },
    release,
  });
  await using screen = await render(<MusicGlobalShortcutSettings />, {
    router: false /* no route context */,
  });

  await screen.getByRole("button", { name: "Record shortcut for Next" }).click();
  await userEvent.keyboard("{Control>}{Alt>}n{/Alt}{/Control}");
  await vi.waitFor(() => expect(shell.saved).toHaveLength(1));
  // The save lands while the keys are still let go; the shell then fails to take Next.
  releaseKeys();
  await expect.element(screen.getByText("Used by another app")).toBeVisible();
});

it("refuses clashing keys beside their binding and saves, warns and clears the rest", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  using shell = setup();
  await using screen = await render(<MusicGlobalShortcutSettings />, {
    router: false /* no route context */,
  });

  await expect.element(screen.getByText("Used by another app")).toBeVisible();

  const recordNext = () => screen.getByRole("button", { name: "Record shortcut for Next" }).click();
  await recordNext();
  // The shell lets go of T3's own keys while recording, so Play/pause's key reaches the check.
  await vi.waitFor(() => expect(shell.recording).toEqual([true]));
  await userEvent.keyboard("{Control>}{Alt>}p{/Alt}{/Control}");
  await expect.element(screen.getByText("Already used for Play/pause.")).toBeVisible();
  await vi.waitFor(() => expect(shell.recording).toEqual([true, false]));

  await recordNext();
  await userEvent.keyboard("{Meta>}{Shift>}2{/Shift}{/Meta}");
  await expect.element(screen.getByText("Already used for SnapShots.")).toBeVisible();

  await recordNext();
  await userEvent.keyboard("{Shift>}n{/Shift}");
  await expect.element(screen.getByText("Include Control, Option or Command.")).toBeVisible();
  expect(shell.saved).toHaveLength(0);

  await recordNext();
  await userEvent.keyboard("{Control>}{Alt>}n{/Alt}{/Control}");
  await vi.waitFor(() =>
    expect(shell.saved.at(-1)?.musicGlobalShortcuts.bindings.next).toEqual(
      chord("n", { ctrlKey: true, altKey: true }),
    ),
  );
  // The shell answered the save, so the stale failure is gone and the in-app clash shows.
  await expect.element(screen.getByText(/^Overrides ".+" in T3 Code\.$/)).toBeVisible();
  await expect.element(screen.getByText("Used by another app")).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Clear shortcut for Play/pause" }).click();
  await vi.waitFor(() =>
    expect(shell.saved.at(-1)?.musicGlobalShortcuts.bindings).toEqual({
      next: chord("n", { ctrlKey: true, altKey: true }),
    }),
  );
});

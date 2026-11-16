import { EnvironmentId, type DesktopBridge, type MusicPlayerState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MusicMiniPlayer } from "./MusicMiniPlayer";

// Fixture atoms stand in for the Music RPCs and the desktop shell: no server, no Music, no Electron.
const fixture = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
  bridge: [] as Array<string>,
}));

const ENV = EnvironmentId.make("env-music");
const STATE: MusicPlayerState = {
  _tag: "ready",
  playback: "playing",
  track: {
    id: "3BA40D4A07B97011",
    name: "Opening",
    artist: "Band",
    album: "Record",
    durationSec: 200,
    favorited: false,
  },
  positionSec: 30,
  shuffle: false,
  repeat: "off",
  volume: 50,
  playlistId: null,
  playlistName: null,
} as unknown as MusicPlayerState;

vi.mock(import("../../state/music"), async () => {
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  return {
    musicEnvironment: {
      artwork: () => A.make(() => Result.success({ dataUrl: null })),
      control: {
        label: "control",
        run: async (_registry: unknown, target: { readonly input: unknown }) => {
          fixture.calls.push(target.input);
          return Result.success(undefined);
        },
        permissionAtom: () => A.make(true),
      },
    } as never,
    useMusicEnvironmentId: (() => ENV) as never,
    useReceivedMusicState: (() => ({ state: STATE, receivedAtMs: Date.now() })) as never,
    useMusicQueueStatus: (() => null) as never,
  };
});

// Keybinding dispatch reads the primary server's keybindings; that path has its own tests.
vi.mock(import("../../shortcuts/useMusicShortcuts"), () => ({
  useMusicShortcuts: () => undefined,
}));

function setup() {
  fixture.calls = [];
  fixture.bridge = [];
  const musicMiniPlayer: DesktopBridge["musicMiniPlayer"] = {
    toggle: async () => void fixture.bridge.push("toggle"),
    getState: async () => ({ pinned: true }),
    setPinned: async (pinned) => void fixture.bridge.push(`pinned:${pinned}`),
    close: async () => void fixture.bridge.push("close"),
    openMain: async () => void fixture.bridge.push("openMain"),
    onSettingsChanged: () => () => undefined,
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { musicMiniPlayer } as unknown as DesktopBridge,
  });
  return { [Symbol.dispose]: () => Reflect.deleteProperty(window, "desktopBridge") };
}

it("reaches every control by keyboard and plays or pauses with Space", async () => {
  using _bridge = setup();
  await using screen = await render(<MusicMiniPlayer />, { router: false /* no route context */ });
  await expect.element(screen.getByRole("button", { name: "Keep on top" })).toBeEnabled();

  const order: Array<string | null> = [];
  for (let index = 0; index < 7; index += 1) {
    await userEvent.tab();
    order.push(document.activeElement?.getAttribute("aria-label") ?? null);
  }
  expect(order).toEqual([
    "Previous track",
    "Pause",
    "Next track",
    "Favorite",
    "Keep on top",
    "Open in T3 Code",
    "Seek",
  ]);

  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard(" ");
  expect(fixture.calls).toEqual([{ _tag: "play-pause" }]);

  await page.getByRole("button", { name: "Keep on top" }).click();
  await page.getByRole("button", { name: "Open in T3 Code" }).click();
  await page.getByRole("button", { name: "Next track" }).click();
  expect(fixture.bridge).toEqual(["pinned:false", "openMain"]);
  expect(fixture.calls).toEqual([{ _tag: "play-pause" }, { _tag: "next" }]);
  await expect
    .element(screen.getByRole("button", { name: "Keep on top" }))
    .toHaveAttribute("aria-pressed", "false");
});

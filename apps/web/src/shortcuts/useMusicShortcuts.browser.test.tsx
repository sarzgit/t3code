import {
  EnvironmentId,
  type DesktopBridge,
  type MusicGlobalShortcutAction,
  type MusicPlayerState,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useMusicShortcuts } from "./useMusicShortcuts";

// Fixture atoms stand in for the Music RPCs and the desktop shell: no server, no Music, no Electron.
const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ readonly environmentId: unknown; readonly input: unknown }>,
  canControl: true,
  environmentId: null as string | null,
}));

const ENV = EnvironmentId.make("env-music");
const STATE = {
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
  playlistId: null,
} as MusicPlayerState;

vi.mock(import("../state/music"), async () => {
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  return {
    musicEnvironment: {
      state: () => A.make(() => Result.success(STATE)),
      control: {
        label: "control",
        run: async (_registry: unknown, target: { environmentId: unknown; input: unknown }) => {
          fixture.calls.push(target);
          return Result.success(undefined);
        },
        permissionAtom: () => A.make(() => fixture.canControl),
      },
    } as never,
    useMusicEnvironmentId: (() => fixture.environmentId) as never,
  };
});

function Host() {
  useMusicShortcuts();
  return null;
}

function setup(options: { readonly canControl: boolean; readonly environmentId: string | null }) {
  fixture.calls = [];
  fixture.canControl = options.canControl;
  fixture.environmentId = options.environmentId;
  const listeners = new Set<(action: MusicGlobalShortcutAction) => void>();
  const musicGlobalShortcuts: DesktopBridge["musicGlobalShortcuts"] = {
    getStatus: async () => ({}),
    setRecording: async () => ({}),
    onAction: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { musicGlobalShortcuts } as unknown as DesktopBridge,
  });
  return {
    listeners,
    send: (action: MusicGlobalShortcutAction) => {
      for (const listener of listeners) listener(action);
    },
    [Symbol.dispose]: () => Reflect.deleteProperty(window, "desktopBridge"),
  };
}

it("acts for the music environment with the sampled track's id", async () => {
  using shell = setup({ canControl: true, environmentId: ENV });
  await using _screen = await render(<Host />, { router: false /* a bare hook host */ });
  await vi.waitFor(() => expect(shell.listeners.size).toBe(1));

  shell.send("favorite");
  shell.send("next");
  // The shell toggles the mini-player itself.
  shell.send("toggleMiniPlayer");
  await vi.waitFor(() =>
    expect(fixture.calls).toEqual([
      {
        environmentId: ENV,
        input: { _tag: "set-favorited", trackId: "3BA40D4A07B97011", favorited: true },
      },
      { environmentId: ENV, input: { _tag: "next" } },
    ]),
  );
});

it.each([
  ["without control permission", { canControl: false, environmentId: ENV }],
  ["with no music environment", { canControl: true, environmentId: null }],
])("ignores desktop music keys %s", async (_name, options) => {
  using shell = setup(options);
  await using _screen = await render(<Host />, { router: false /* a bare hook host */ });
  expect(shell.listeners.size).toBe(0);
});

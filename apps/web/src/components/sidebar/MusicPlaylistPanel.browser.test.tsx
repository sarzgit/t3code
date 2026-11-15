import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type MusicPlayerState,
  type MusicQueueStatus,
  type MusicQueueView,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { MusicPanel } from "./MusicPlaylistPanel";

// Fixture atoms stand in for the Music RPCs: no server, no Music app.
const fixture = vi.hoisted(() => ({
  status: null as unknown,
  view: null as unknown,
  viewReads: 0,
  calls: [] as Array<{ readonly tag: string; readonly input: unknown }>,
  refs: [] as Array<{ readonly id: string; readonly revision: number }>,
  /** Set by the mock; refreshing it publishes `status` like the server's stream. */
  statusAtom: null as unknown,
}));

function setup(status: MusicQueueStatus, view: MusicQueueView | null) {
  fixture.status = status;
  fixture.view = view;
  fixture.viewReads = 0;
  fixture.calls = [];
  fixture.refs = [];
}

vi.mock(import("../../state/music"), async () => {
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  const { useEnvironmentQuery } = await import("../../state/query");
  const value = <T,>(read: () => T) => {
    const atom = A.make(() => Result.success(read()));
    return () => atom;
  };
  const command = (tag: string) => ({
    label: tag,
    run: async (_registry: unknown, target: { readonly input: unknown }) => {
      fixture.calls.push({ tag, input: target.input });
      return Result.success(fixture.refs.shift() ?? { id: "qfixture1", revision: 0 });
    },
    permissionAtom: () => A.make(true),
  });
  const statusAtom = A.make(() => Result.success(fixture.status as MusicQueueStatus));
  fixture.statusAtom = statusAtom;
  const viewAtom = A.make(() => {
    fixture.viewReads += 1;
    return Result.success(fixture.view as MusicQueueView);
  });
  return {
    musicEnvironment: {
      artwork: value(() => ({ dataUrl: null })),
      playlists: value(() => ({
        playlists: [{ id: "5CA38D01224697B3", name: "Mix", durationSec: 600 }],
      })),
      tracks: value(() => ({
        tracks: [
          { id: "AAAA000000000001", index: 0, name: "Opening", artist: "Band", durationSec: 200 },
        ],
        total: 1,
      })),
      upNext: value(() => ({ playlistName: "Mix", tracks: [] })),
      nativeQueue: value(() => ({ _tag: "ok", sections: [], complete: true })),
      queue: () => statusAtom,
      queueView: () => viewAtom,
      control: command("control"),
      playTrack: command("playTrack"),
      playPlaylist: command("playPlaylist"),
      editQueue: command("editQueue"),
      resumeQueue: command("resumeQueue"),
      dismissSavedQueue: command("dismissSavedQueue"),
      undoReplace: command("undoReplace"),
    } as never,
    useMusicQueueStatus: (() => useEnvironmentQuery(statusAtom).data) as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const { Atom: A } = await import("effect/reactivity");
  const settings = A.make(null);
  return {
    ...(await original()),
    serverEnvironment: {
      settingsValueAtom: () => settings,
      updateSettings: { label: "settings", run: async () => ({ _tag: "Success", value: {} }) },
    } as never,
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));

const ENV = EnvironmentId.make("env-music");
const SONG = "3BA40D4A07B97011";
const DUPLICATE = "BBBB000000000002";

const playing = (overrides: Partial<Extract<MusicPlayerState, { _tag: "ready" }>> = {}) =>
  ({
    _tag: "ready",
    playback: "playing",
    track: { id: SONG, name: "Now", artist: "Band", album: "Live", durationSec: 200 },
    positionSec: 10,
    shuffle: false,
    playlistId: "5CA38D01224697B3",
    repeat: "off",
    ...overrides,
  }) as MusicPlayerState;

const entry = (key: string, trackId: string, name: string) => ({
  key,
  trackId,
  name,
  artist: "Band",
  durationSec: 180,
  unavailable: false,
});

const formulaView: MusicQueueView = {
  id: "qformula1",
  revision: 0,
  currentKey: "s3",
  edited: false,
  sourceName: "Mix",
  sourceCount: 12,
  current: entry("s3", SONG, "Now"),
  upcoming: [
    entry("s4", DUPLICATE, "Twice"),
    entry("s5", DUPLICATE, "Twice"),
    entry("s6", "CCCC000000000003", "Later"),
  ],
  totalUpcoming: 8,
  wraps: false,
  shuffled: false,
};

const status = (overrides: Partial<MusicQueueStatus> = {}): MusicQueueStatus => ({
  active: { id: "qformula1", revision: 0, edited: false, currentKey: "s3" },
  saved: null,
  replaced: null,
  favouritesRevision: 0,
  recentRevision: 0,
  ...overrides,
});

async function renderPanel(registry: AtomRegistry.AtomRegistry, state: MusicPlayerState) {
  return render(
    <RegistryContext.Provider value={registry}>
      <MusicPanel environmentId={ENV} state={state} controllable />
    </RegistryContext.Provider>,
    { router: false },
  );
}

/** Publishes a new queue status, as the server's stream would. */
const publish = (registry: AtomRegistry.AtomRegistry, next: MusicQueueStatus) =>
  act(() => {
    fixture.status = next;
    registry.refresh(fixture.statusAtom as Atom.Atom<unknown>);
  });

const upNextTab = { name: "Up Next", exact: true } as const;

const editInputs = () =>
  fixture.calls.filter((call) => call.tag === "editQueue").map((call) => call.input);

it("keeps T3's queue editable under repeat one and moves the right duplicate by keyboard", async () => {
  setup(status(), formulaView);
  const registry = AtomRegistry.make();
  // Music's own shuffle and repeat one would hide a formula list; an active queue still shows it.
  await using screen = await renderPanel(registry, playing({ repeat: "one", shuffle: true }));
  await userEvent.click(screen.getByRole("button", upNextTab));

  await expect.element(screen.getByLabelText("Repeats")).toBeInTheDocument();
  await expect.element(screen.getByText("This song repeats")).not.toBeInTheDocument();
  await expect.element(screen.getByText("5 more")).toBeInTheDocument();

  const second = screen.getByRole("button", { name: "Edit Twice in Up Next" }).nth(1);
  (second.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(page.getByRole("menuitem", { name: "Move up" }));

  expect(editInputs()).toEqual([
    {
      queueId: "qformula1",
      expectedRevision: 0,
      sourceCount: 12,
      edit: { _tag: "move", target: { key: "s5", trackId: DUPLICATE }, toIndex: 0 },
    },
  ]);

  // The server materialises and publishes a new revision; the list re-reads in the new order.
  const reads = fixture.viewReads;
  fixture.view = {
    ...formulaView,
    revision: 1,
    edited: true,
    upcoming: [formulaView.upcoming[1]!, formulaView.upcoming[0]!, formulaView.upcoming[2]!],
  };
  await publish(
    registry,
    status({ active: { id: "qformula1", revision: 1, edited: true, currentKey: "s3" } }),
  );
  await vi.waitFor(() => expect(fixture.viewReads).toBeGreaterThan(reads));
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit Twice in Up Next" }).nth(0).element(),
    ),
  );
});

it("removes an entry and Undo restores that same entry at the revision the remove made", async () => {
  const explicit = { ...formulaView, revision: 4, edited: true };
  setup(
    status({ active: { id: "qformula1", revision: 4, edited: true, currentKey: "s3" } }),
    explicit,
  );
  fixture.refs = [{ id: "qformula1", revision: 5 }];
  using add = vi.spyOn(toastManager, "add");
  const registry = AtomRegistry.make();
  await using screen = await renderPanel(registry, playing());
  await userEvent.click(screen.getByRole("button", upNextTab));

  await userEvent.click(screen.getByRole("button", { name: "Edit Later in Up Next" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));

  await vi.waitFor(() => expect(add).toHaveBeenCalled());
  const toast = add.mock.calls.at(-1)![0];
  expect(toast.title).toBe("Removed from Up Next");
  const undo = toast.actionProps?.onClick as (() => void) | undefined;
  expect(undo).toBeDefined();
  await act(() => undo!());

  const target = { key: "s6", trackId: "CCCC000000000003" };
  await vi.waitFor(() =>
    expect(editInputs()).toEqual([
      { queueId: "qformula1", expectedRevision: 4, edit: { _tag: "remove", targets: [target] } },
      { queueId: "qformula1", expectedRevision: 5, edit: { _tag: "undo-remove", target } },
    ]),
  );
});

it("queues a playlist song only while T3 runs Up Next, sending a formula queue's song count", async () => {
  setup(status({ active: null }), formulaView);
  const registry = AtomRegistry.make();
  await using screen = await renderPanel(registry, playing());
  await userEvent.click(screen.getByRole("button", { name: /^Mix/ }));

  await userEvent.click(screen.getByRole("button", { name: "More for Opening" }));
  await expect
    .element(page.getByRole("menuitem", { name: "Play next" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");

  await publish(registry, status());
  await userEvent.click(screen.getByRole("button", { name: "More for Opening" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Play next" }));

  await vi.waitFor(() =>
    expect(editInputs()).toEqual([
      {
        queueId: "qformula1",
        expectedRevision: 0,
        sourceCount: 12,
        edit: {
          _tag: "play-next",
          songs: [{ playlistId: "5CA38D01224697B3", trackId: "AAAA000000000001", index: 0 }],
        },
      },
    ]),
  );
});

it("offers the saved queue by id and revision, and only Dismiss once its playlist is gone", async () => {
  const saved = {
    id: "qsaved0001",
    revision: 7,
    trackName: "Saved song",
    artist: "Band",
    sourceName: "Mix",
    positionSec: 84,
    sourceMissing: false,
  };
  setup(status({ active: null, saved }), null);
  const registry = AtomRegistry.make();
  await using screen = await renderPanel(registry, playing({ playlistId: null }));
  await userEvent.click(screen.getByRole("button", upNextTab));

  await expect.element(screen.getByText("Band · Mix · 1:24")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Resume Saved song" }));
  await userEvent.click(screen.getByRole("button", { name: "Dismiss saved queue" }));
  await vi.waitFor(() =>
    expect(fixture.calls).toEqual([
      { tag: "resumeQueue", input: { queueId: "qsaved0001", revision: 7 } },
      { tag: "dismissSavedQueue", input: { queueId: "qsaved0001", revision: 7 } },
    ]),
  );

  await publish(registry, status({ active: null, saved: { ...saved, sourceMissing: true } }));
  await expect.element(screen.getByText("Playlist no longer in your library")).toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Resume Saved song" }))
    .not.toBeInTheDocument();
});

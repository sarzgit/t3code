import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type MusicStats,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { ReactNode } from "react";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ListeningStats } from "./MusicListeningStats";
import { HiddenMusicProjectsSettings } from "../settings/HiddenMusicProjectsSettings";

const state = vi.hoisted(() => ({
  settings: null as unknown as Atom.Writable<ServerSettings | null>,
  canWrite: null as unknown as Atom.Writable<boolean>,
  stats: null as unknown as MusicStats,
  titles: {} as Record<string, string>,
  persist: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => state.settings,
    updateSettings: { permissionAtom: () => state.canWrite },
  },
}));
vi.mock("~/state/music", () => ({
  musicEnvironment: {
    stats: () => ({}),
    importHistory: { permissionAtom: () => state.canWrite },
    clearHistory: {},
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.stats, error: null, refresh: () => undefined }),
}));
vi.mock("~/state/entities", () => ({
  useProject: ({ projectId }: { projectId: ProjectId }) => ({ title: state.titles[projectId] }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../settings/SettingsScopeContext", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useSettingsScope: () => ({
      connectedEnvironments: [
        {
          environmentId: "music-test",
          label: "Test Mac",
          serverConfig: { settings: useAtomValue(state.settings) },
        },
      ],
    }),
  };
});
vi.mock("../settings/settingsLayout", () => ({
  SettingsRow: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));
vi.mock("../settings/settingsSearch", () => ({
  searchableSetting: () => ({ id: "music-hidden-projects", title: "Hidden Music projects" }),
}));

function setup() {
  state.settings = Atom.make<ServerSettings | null>(null);
  state.canWrite = Atom.make(true);
  state.titles = { alpha: "Alpha", beta: "Beta" };
  state.persist.mockReset();
  state.toast.mockReset();
  state.stats = {
    totalSec: 18000,
    days: [],
    artists: [],
    tracks: [],
    projects: [
      { projectId: ProjectId.make("alpha"), seconds: 3600 },
      { projectId: ProjectId.make("beta"), seconds: 1200 },
    ],
  };
}

it("waits for saved visibility, keeps failed hides visible and removes only saved project rows", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext value={registry}>
      <ListeningStats environmentId={EnvironmentId.make("music-test")} />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("5 hr 0 min")).toBeVisible();
  await expect.element(screen.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Beta", { exact: true })).not.toBeInTheDocument();

  await act(() =>
    registry.set(state.settings, {
      ...DEFAULT_SERVER_SETTINGS,
      musicStatsHiddenProjects: [ProjectId.make("alpha")],
    }),
  );
  await expect.element(screen.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Beta", { exact: true })).toBeVisible();

  await act(() => registry.set(state.settings, DEFAULT_SERVER_SETTINGS));
  state.persist.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
  await screen.getByRole("button", { name: "Stats for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Hide project" }).click();
  await expect.element(screen.getByText("Alpha", { exact: true })).toBeVisible();
  expect(state.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Project not hidden",
    description: "Try again.",
  });

  state.persist.mockImplementation(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
    registry.set(
      state.settings,
      applyServerSettingsPatch(
        registry.get(state.settings) ?? DEFAULT_SERVER_SETTINGS,
        input.patch,
      ),
    );
    return AsyncResult.success(undefined);
  });
  await screen.getByRole("button", { name: "Stats for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Hide project" }).click();
  await expect.element(screen.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Beta", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("5 hr 0 min")).toHaveFocus();
  await expect.element(screen.getByText(/restore|unhide|hidden/i)).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Stats for Beta" }).click();
  await page.getByRole("menuitem", { name: "Hide project" }).click();
  await expect
    .element(screen.getByRole("heading", { name: "While agents worked" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("5 hr 0 min")).toBeVisible();

  state.titles.beta = "Renamed Beta";
  await screen.rerender(
    <RegistryContext value={registry}>
      <HiddenMusicProjectsSettings />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("Renamed Beta", { exact: true })).toBeVisible();
  state.persist.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
  await screen.getByRole("button", { name: "Restore Alpha to Music Stats" }).click();
  await expect.element(screen.getByText("Alpha", { exact: true })).toBeVisible();
  expect(state.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Project not restored",
    description: "Try again.",
  });
  await screen.getByRole("button", { name: "Restore Alpha to Music Stats" }).click();
  await expect.element(screen.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Renamed Beta", { exact: true })).toBeVisible();
  await screen.rerender(
    <RegistryContext value={registry}>
      <ListeningStats environmentId={EnvironmentId.make("music-test")} />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("Alpha", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Renamed Beta", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("5 hr 0 min")).toBeVisible();
});

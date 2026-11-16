import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { exposeClerkBridge, exposeInMainWorld } = vi.hoisted(() => ({
  exposeClerkBridge: vi.fn(),
  exposeInMainWorld: vi.fn(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    sendSync: () => null,
    invoke: async () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  },
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: () => "" },
}));

describe("desktop preloads", () => {
  beforeEach(() => {
    // jsdom leaves this undefined; Chromium reports null when nothing is fullscreen.
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    vi.resetModules();
    exposeClerkBridge.mockReset();
    exposeInMainWorld.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("gives the main window the desktop bridge and Clerk's sign-in bridge", async () => {
    await import("./preload.ts");
    expect(exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual(["desktopBridge"]);
    expect(exposeClerkBridge).toHaveBeenCalledWith({ passkeys: true });
  });

  it("gives the mini-player the desktop bridge only, never Clerk's", async () => {
    await import("./musicMiniPlayerPreload.ts");
    expect(exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual(["desktopBridge"]);
    expect(exposeClerkBridge).not.toHaveBeenCalled();
  });
});

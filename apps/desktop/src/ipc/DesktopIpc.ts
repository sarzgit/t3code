import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { isSameOriginRendererNavigation } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "./channels.ts";

export interface DesktopIpcInvokeEvent {
  readonly sender: { readonly id: number };
  readonly senderFrame?: unknown;
}

/**
 * Everything the music mini-player renderer may call. It boots the same web app as the main
 * window, so each entry is a read the app needs to boot, authenticate and connect to the primary
 * environment, or one of the mini-player's own window controls. Everything else, including every
 * file, shell, dialog, navigation, permission and settings-write channel, stays main-window only.
 */
const MUSIC_MINI_PLAYER_IPC_CHANNELS: ReadonlySet<string> = new Set([
  // Primary environment HTTP/WebSocket URLs and the bootstrap credential the auth gate exchanges.
  IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
  // Bearer token for the primary environment's WebSocket, which carries Music state and keybindings.
  IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
  // The root route reads it before choosing a connection; read-only.
  IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  // musicPlayerEnabled and appearance; the mini-player never writes settings.
  IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  // Read while shared modules load; static app name and stage.
  IpcChannels.GET_APP_BRANDING_CHANNEL,
  // Managed policy telemetry opt-out; an unanswered read would count as enabled.
  IpcChannels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL,
  // The shared preload reads it on every document; read-only.
  IpcChannels.GET_PRIMARY_PASTE_ENABLED_CHANNEL,
  // The mini-player's own window: pin state, close and "Open in T3".
  IpcChannels.MUSIC_MINI_PLAYER_GET_STATE_CHANNEL,
  IpcChannels.MUSIC_MINI_PLAYER_SET_PINNED_CHANNEL,
  IpcChannels.MUSIC_MINI_PLAYER_CLOSE_CHANNEL,
  IpcChannels.MUSIC_MINI_PLAYER_OPEN_MAIN_CHANNEL,
]);

interface IpcSenderWindow {
  readonly webContents: { readonly id: number; readonly mainFrame: unknown };
}

const readFrameUrl = (frame: unknown): string | null => {
  if (typeof frame !== "object" || frame === null || !("url" in frame)) return null;
  return typeof frame.url === "string" ? frame.url : null;
};

/** Main window: every channel. Mini-player: its allowlist, from its top frame on the app origin. */
function isTrustedIpcSender(input: {
  readonly channel: string;
  readonly event: DesktopIpcInvokeEvent;
  readonly main: Option.Option<IpcSenderWindow>;
  readonly musicMiniPlayer: Option.Option<{
    readonly window: IpcSenderWindow;
    readonly applicationUrl: string;
  }>;
}): boolean {
  const { channel, event } = input;
  const isTopFrameOf = (window: IpcSenderWindow) =>
    window.webContents.id === event.sender.id && window.webContents.mainFrame === event.senderFrame;
  if (Option.isSome(input.main) && isTopFrameOf(input.main.value)) return true;
  if (Option.isNone(input.musicMiniPlayer)) return false;
  const { window, applicationUrl } = input.musicMiniPlayer.value;
  const frameUrl = readFrameUrl(event.senderFrame);
  return (
    MUSIC_MINI_PLAYER_IPC_CHANNELS.has(channel) &&
    isTopFrameOf(window) &&
    frameUrl !== null &&
    isSameOriginRendererNavigation({ applicationUrl, navigationUrl: frameUrl })
  );
}

export interface DesktopIpcSyncEvent extends DesktopIpcInvokeEvent {
  returnValue: unknown;
}

export type DesktopIpcSenderGuard = (
  event: DesktopIpcInvokeEvent,
  channel: string,
) => Effect.Effect<boolean>;

export type DesktopIpcHandleListener = (
  event: DesktopIpcInvokeEvent,
  raw: unknown,
) => unknown | Promise<unknown>;

export type DesktopIpcSyncListener = (event: DesktopIpcSyncEvent) => void;

export interface DesktopIpcMain {
  removeHandler(channel: string): void;
  handle(channel: string, listener: DesktopIpcHandleListener): void;
  removeAllListeners(channel: string): void;
  on(channel: string, listener: DesktopIpcSyncListener): void;
}

export class DesktopIpcRegistrationError extends Schema.TaggedError<DesktopIpcRegistrationError>()(
  "DesktopIpcRegistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export class DesktopIpcUnregistrationError extends Schema.TaggedError<DesktopIpcUnregistrationError>()(
  "DesktopIpcUnregistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export class DesktopIpcUntrustedSenderError extends Schema.TaggedError<DesktopIpcUntrustedSenderError>()(
  "DesktopIpcUntrustedSenderError",
  { channel: Schema.String },
) {
  override get message(): string {
    return `Rejected ${this.channel} from a sender that is not the app window.`;
  }
}

export const DesktopIpcError = Schema.Union([
  DesktopIpcRegistrationError,
  DesktopIpcUnregistrationError,
]);
export type DesktopIpcError = typeof DesktopIpcError.Type;

export interface DesktopIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: (raw: unknown, event?: DesktopIpcInvokeEvent) => Effect.Effect<unknown, E, R>;
}

export interface DesktopSyncIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: () => Effect.Effect<unknown, E, R>;
}

export class DesktopIpc extends Context.Service<
  DesktopIpc,
  {
    readonly handle: <E, R>(
      input: DesktopIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
    readonly handleSync: <E, R>(
      input: DesktopSyncIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
  }
>()("@t3tools/desktop/ipc/DesktopIpc") {}

// ipcMain is shared by every webContents, including preview guests that load arbitrary pages.
export const make = (
  ipcMain: DesktopIpcMain,
  isTrustedSender: DesktopIpcSenderGuard,
): DesktopIpc["Service"] =>
  DesktopIpc.of({
    handle: Effect.fn("desktop.ipc.registerInvoke")(function* <E, R>({
      channel,
      handler,
    }: DesktopIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (event, raw) =>
              runPromise(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  if (!(yield* isTrustedSender(event, channel))) {
                    return yield* new DesktopIpcUntrustedSenderError({ channel });
                  }
                  return yield* handler(raw, event);
                }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invoke")),
              ),
            );
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "invoke", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeHandler(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "invoke", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),

    handleSync: Effect.fn("desktop.ipc.registerSync")(function* <E, R>({
      channel,
      handler,
    }: DesktopSyncIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runSync = Effect.runSyncWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeAllListeners(channel);
            ipcMain.on(channel, (event) => {
              event.returnValue = runSync(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  // Throwing here would surface as an uncaught main-process exception.
                  if (!(yield* isTrustedSender(event, channel))) {
                    yield* Effect.logWarning("Rejected sync IPC from an untrusted sender.");
                    return undefined;
                  }
                  return yield* handler();
                }).pipe(
                  Effect.annotateLogs({ channel }),
                  Effect.withSpan("desktop.ipc.invokeSync"),
                ),
              );
            });
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "sync", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeAllListeners(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "sync", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),
  });

export const layer = (ipcMain: DesktopIpcMain) =>
  Layer.effect(
    DesktopIpc,
    Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      return make(ipcMain, (event, channel) =>
        Effect.all([electronWindow.main, electronWindow.musicMiniPlayer]).pipe(
          Effect.map(([main, musicMiniPlayer]) =>
            isTrustedIpcSender({ channel, event, main, musicMiniPlayer }),
          ),
        ),
      );
    }),
  );

export const layerTest = (ipcMain: DesktopIpcMain) =>
  Layer.succeed(
    DesktopIpc,
    make(ipcMain, () => Effect.succeed(true)),
  );

export interface DesktopIpcMethodRegistration<
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly payload: Schema.Codec<
    Payload,
    EncodedPayload,
    PayloadDecodingServices,
    PayloadEncodingServices
  >;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: (input: Payload, event?: DesktopIpcInvokeEvent) => Effect.Effect<Result, E, R>;
}

export const makeIpcMethod = <
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopIpcMethodRegistration<
    Payload,
    EncodedPayload,
    Result,
    EncodedResult,
    E,
    R,
    PayloadDecodingServices,
    PayloadEncodingServices,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopIpcMethod<
  E | Schema.SchemaError,
  R | PayloadDecodingServices | ResultEncodingServices
> => {
  const decode = Schema.decodeUnknownEffect(method.payload);
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: (raw, event) =>
      decode(raw).pipe(
        Effect.flatMap((input) => method.handler(input, event)),
        Effect.flatMap(encode),
        Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
      ),
  };
};

export interface DesktopSyncIpcMethodRegistration<
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: () => Effect.Effect<Result, E, R>;
}

export const makeSyncIpcMethod = <
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopSyncIpcMethodRegistration<
    Result,
    EncodedResult,
    E,
    R,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopSyncIpcMethod<E | Schema.SchemaError, R | ResultEncodingServices> => {
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: () =>
      method
        .handler()
        .pipe(
          Effect.flatMap(encode),
          Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
        ),
  };
};

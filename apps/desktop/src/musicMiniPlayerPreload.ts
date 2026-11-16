// The mini-player: the desktop bridge only. It never gets Clerk's sign-in, token or passkey
// bridge, and MiniPlayerWindow refuses those channels from it in the main process as well.
import "./desktopBridgePreload.ts";

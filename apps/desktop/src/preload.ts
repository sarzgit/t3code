// The main window: the desktop bridge plus Clerk's sign-in, token and passkey bridge.
import { exposeClerkBridge } from "@clerk/electron/preload";

import "./desktopBridgePreload.ts";

exposeClerkBridge({ passkeys: true });

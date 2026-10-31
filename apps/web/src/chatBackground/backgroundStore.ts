import type { BackgroundPalette } from "./backgroundPalette";

const DATABASE_NAME = "t3code:chat-background";
const DATABASE_VERSION = 1;
const STORE_NAME = "background";
const RECORD_KEY = "current";

export type ChatBackgroundRecord = Readonly<{
  image: Blob;
  palette: BackgroundPalette;
  /** Theme selection to restore when the background is removed. */
  previousTheme: string;
  previousThemeHalves: string | null;
}>;

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Chat background storage is blocked.")),
    );
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request.result;
}

export async function readChatBackground(): Promise<ChatBackgroundRecord | null> {
  const record = await withStore("readonly", (store) => store.get(RECORD_KEY));
  if (!isChatBackgroundRecord(record)) return null;
  // Records saved before extremes were sampled still load; the tint then uses the main colours.
  return Array.isArray(record.palette.extremes)
    ? record
    : { ...record, palette: { ...record.palette, extremes: [] } };
}

export async function writeChatBackground(record: ChatBackgroundRecord): Promise<void> {
  await withStore("readwrite", (store) => store.put(record, RECORD_KEY));
}

export async function deleteChatBackground(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
}

function isChatBackgroundRecord(value: unknown): value is ChatBackgroundRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ChatBackgroundRecord>;
  return (
    record.image instanceof Blob &&
    typeof record.palette?.dominant === "string" &&
    typeof record.previousTheme === "string"
  );
}

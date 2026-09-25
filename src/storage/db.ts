import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { TargetLanguageCode } from "../../shared/languages";

/**
 * Best-effort local persistence in IndexedDB. Every call can fail (private
 * browsing, blocked storage, quota) and callers must keep working in memory.
 *
 * Only one document's bytes are kept (the current paper). Reading positions
 * and completed translations are kept for a few recent papers, so reopening
 * the same file later restores them.
 */

export interface StoredDocumentMeta {
  fingerprint: string;
  title: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  source: { kind: "upload" | "link" | "sample"; url?: string };
  openedAt: number;
}

export interface ReadingPosition {
  fingerprint: string;
  pageIndex: number;
  /** Position of the viewport top within the page, 0..1. */
  pageOffset: number;
  zoom: { mode: "auto" | "fit-width" | "custom"; scale: number };
  updatedAt: number;
}

export interface StoredTranslation {
  key: string;
  fingerprint: string;
  targetLang: TargetLanguageCode;
  sourceLang: string | null;
  sourceText: string;
  translation: string;
  provider: string;
  model: string;
  configVersion: string;
  anchor: unknown;
  createdAt: number;
}

interface PassageDB extends DBSchema {
  documents: { key: string; value: StoredDocumentMeta };
  blobs: { key: string; value: { fingerprint: string; blob: Blob } };
  app: { key: string; value: { key: string; value: string } };
  positions: { key: string; value: ReadingPosition };
  translations: { key: string; value: StoredTranslation; indexes: { byFingerprint: string } };
}

const DB_NAME = "passage";
const RECENT_DOCUMENTS = 10;
const MAX_TRANSLATIONS_PER_DOCUMENT = 500;

let dbPromise: Promise<IDBPDatabase<PassageDB>> | null = null;

function db(): Promise<IDBPDatabase<PassageDB>> {
  if (!dbPromise) {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"));
    dbPromise = openDB<PassageDB>(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore("documents", { keyPath: "fingerprint" });
        database.createObjectStore("blobs", { keyPath: "fingerprint" });
        database.createObjectStore("app", { keyPath: "key" });
        database.createObjectStore("positions", { keyPath: "fingerprint" });
        const translations = database.createObjectStore("translations", { keyPath: "key" });
        translations.createIndex("byFingerprint", "fingerprint");
      },
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

export type StorageResult = { ok: true } | { ok: false; reason: "unavailable" | "quota" | "error" };

function classify(error: unknown): StorageResult {
  const name = (error as { name?: string })?.name;
  if (name === "QuotaExceededError") return { ok: false, reason: "quota" };
  if (name === "InvalidStateError" || name === "SecurityError" || /not available/i.test(String(error))) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: false, reason: "error" };
}

/** Saves the current paper, replacing the previously saved file. */
export async function saveCurrentDocument(meta: StoredDocumentMeta, bytes: Uint8Array): Promise<StorageResult> {
  try {
    const database = await db();
    const tx = database.transaction(["documents", "blobs", "app"], "readwrite");
    const previous = await tx.objectStore("app").get("current");
    if (previous && previous.value !== meta.fingerprint) {
      await tx.objectStore("blobs").delete(previous.value);
    }
    await tx.objectStore("documents").put(meta);
    await tx.objectStore("blobs").put({ fingerprint: meta.fingerprint, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) });
    await tx.objectStore("app").put({ key: "current", value: meta.fingerprint });
    await tx.done;
    void pruneOldDocuments(meta.fingerprint);
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

/** Marks a paper as current without re-saving its bytes (they may be unavailable). */
export async function loadCurrentDocumentMeta(): Promise<StoredDocumentMeta | null> {
  try {
    const database = await db();
    const current = await database.get("app", "current");
    if (!current) return null;
    const [meta, blob] = await Promise.all([database.get("documents", current.value), database.getKey("blobs", current.value)]);
    return meta && blob ? meta : null;
  } catch {
    return null;
  }
}

export async function loadDocumentBytes(fingerprint: string): Promise<Uint8Array | null> {
  try {
    const database = await db();
    const record = await database.get("blobs", fingerprint);
    if (!record) return null;
    return new Uint8Array(await record.blob.arrayBuffer());
  } catch {
    return null;
  }
}

export async function savePosition(position: ReadingPosition): Promise<StorageResult> {
  try {
    await (await db()).put("positions", position);
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

export async function loadPosition(fingerprint: string): Promise<ReadingPosition | null> {
  try {
    return (await (await db()).get("positions", fingerprint)) ?? null;
  } catch {
    return null;
  }
}

export async function saveTranslation(entry: StoredTranslation): Promise<StorageResult> {
  try {
    await (await db()).put("translations", entry);
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

export async function loadTranslation(key: string): Promise<StoredTranslation | null> {
  try {
    return (await (await db()).get("translations", key)) ?? null;
  } catch {
    return null;
  }
}

/** Removes every saved paper, position, and translation from this browser. */
export async function clearAllData(): Promise<StorageResult> {
  try {
    const database = await db();
    const tx = database.transaction(["documents", "blobs", "app", "positions", "translations"], "readwrite");
    await Promise.all([
      tx.objectStore("documents").clear(),
      tx.objectStore("blobs").clear(),
      tx.objectStore("app").clear(),
      tx.objectStore("positions").clear(),
      tx.objectStore("translations").clear(),
    ]);
    await tx.done;
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

/** Keeps positions and translations for the most recent papers only. */
async function pruneOldDocuments(currentFingerprint: string): Promise<void> {
  try {
    const database = await db();
    const all = await database.getAll("documents");
    const stale = all
      .filter((doc) => doc.fingerprint !== currentFingerprint)
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(RECENT_DOCUMENTS - 1);
    for (const doc of stale) {
      const tx = database.transaction(["documents", "positions", "translations", "blobs"], "readwrite");
      await tx.objectStore("documents").delete(doc.fingerprint);
      await tx.objectStore("positions").delete(doc.fingerprint);
      await tx.objectStore("blobs").delete(doc.fingerprint);
      const keys = await tx.objectStore("translations").index("byFingerprint").getAllKeys(doc.fingerprint);
      await Promise.all(keys.map((key) => tx.objectStore("translations").delete(key)));
      await tx.done;
    }
    const keys = await database.getAllKeysFromIndex("translations", "byFingerprint", currentFingerprint);
    if (keys.length > MAX_TRANSLATIONS_PER_DOCUMENT) {
      const entries = (await Promise.all(keys.map((key) => database.get("translations", key)))).filter(Boolean) as StoredTranslation[];
      entries.sort((a, b) => a.createdAt - b.createdAt);
      const tx = database.transaction("translations", "readwrite");
      await Promise.all(entries.slice(0, entries.length - MAX_TRANSLATIONS_PER_DOCUMENT).map((e) => tx.store.delete(e.key)));
      await tx.done;
    }
  } catch {
    // Pruning is housekeeping; ignore failures.
  }
}

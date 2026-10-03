/** Minimal IndexedDB wrapper for save slots (saves are several MB, too big for localStorage). */
import type { SaveMeta } from '../engine/save';

const DB_NAME = 'hockey-gm';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putSave(meta: SaveMeta, text: string): Promise<void> {
  await tx('saves', 'readwrite', (s) => s.put(text, meta.id));
  await tx('meta', 'readwrite', (s) => s.put(meta, meta.id));
}

export async function getSave(id: string): Promise<string | undefined> {
  return tx<string | undefined>('saves', 'readonly', (s) => s.get(id) as IDBRequest<string | undefined>);
}

export async function listSaves(): Promise<SaveMeta[]> {
  const all = await tx<SaveMeta[]>('meta', 'readonly', (s) => s.getAll() as IDBRequest<SaveMeta[]>);
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteSave(id: string): Promise<void> {
  await tx('saves', 'readwrite', (s) => s.delete(id));
  await tx('meta', 'readwrite', (s) => s.delete(id));
}

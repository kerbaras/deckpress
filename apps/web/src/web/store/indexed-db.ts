import type { Document, DocumentStore } from "./documents.ts";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const open = indexedDB.open("deckpress", 1);
  open.onupgradeneeded = () => {
    const documents = open.result.createObjectStore("documents", {
      keyPath: ["kind", "id"],
    });
    documents.createIndex("kind", "kind");
  };
  return request(open).then((db) => {
    db.onversionchange = () => db.close();
    return db;
  });
}

export function indexedDbDocuments(): DocumentStore {
  let database: Promise<IDBDatabase> | undefined;
  let requestedPersistence = false;

  async function transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    if (!requestedPersistence) {
      requestedPersistence = true;
      void navigator.storage?.persist?.().catch(() => {});
    }
    database ??= openDatabase().catch((error: unknown) => {
      database = undefined;
      throw error;
    });
    const db = await database;
    const transaction = db.transaction("documents", mode);
    const finished = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const [result] = await Promise.all([
      operation(transaction.objectStore("documents")),
      finished,
    ]);
    return result;
  }

  return {
    get: (kind, id) =>
      transact("readonly", (store) =>
        request<Document | undefined>(store.get([kind, id])),
      ),
    list: (kind) =>
      transact("readonly", async (store) => {
        const rows: Document[] = await request(
          store.index("kind").getAll(kind),
        );
        return rows.sort((a, b) => b.updatedAt - a.updatedAt);
      }),
    put: (document) =>
      transact("readwrite", async (store) => {
        await request(store.put(document));
      }),
    remove: (kind, id) =>
      transact("readwrite", (store) => request(store.delete([kind, id]))),
    change: (kind, id, update) =>
      transact(
        "readwrite",
        (store) =>
          new Promise((resolve, reject) => {
            const get: IDBRequest<Document | undefined> = store.get([kind, id]);
            get.onerror = () => reject(get.error);
            get.onsuccess = () => {
              try {
                const changed = update(get.result);
                void request(store.put(changed)).then(
                  () => resolve(changed),
                  reject,
                );
              } catch (error) {
                reject(error);
              }
            };
          }),
      ),
  };
}

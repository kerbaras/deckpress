import type { Document, DocumentStore } from "./documents.ts";

export function memoryDocuments(): DocumentStore {
  const documents = new Map<string, Document>();
  const key = (kind: string, id: string) => JSON.stringify([kind, id]);
  return {
    async get(kind, id) {
      return documents.get(key(kind, id));
    },
    async list(kind) {
      return [...documents.values()]
        .filter((row) => row.kind === kind)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async put(row) {
      documents.set(key(row.kind, row.id), row);
    },
    async putMany(rows) {
      for (const row of rows) documents.set(key(row.kind, row.id), row);
    },
    async remove(kind, id) {
      documents.delete(key(kind, id));
    },
    async change(kind, id, update) {
      const idKey = key(kind, id);
      const row = update(documents.get(idKey));
      documents.set(idKey, row);
      return row;
    },
  };
}

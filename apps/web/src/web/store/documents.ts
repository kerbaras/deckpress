export interface Document {
  kind: string;
  id: string;
  json: string;
  updatedAt: number;
}

export interface DocumentStore {
  get(kind: string, id: string): Promise<Document | undefined>;
  list(kind: string): Promise<Document[]>;
  put(document: Document): Promise<void>;
  putMany(documents: Document[]): Promise<void>;
  remove(kind: string, id: string): Promise<void>;
  change(
    kind: string,
    id: string,
    update: (document: Document | undefined) => Document,
  ): Promise<Document>;
}

export function document(
  kind: string,
  id: string,
  value: unknown,
  updatedAt = Date.now(),
): Document {
  return { kind, id, json: JSON.stringify(value), updatedAt };
}

export function readDocument(row: Document): unknown {
  return JSON.parse(row.json);
}

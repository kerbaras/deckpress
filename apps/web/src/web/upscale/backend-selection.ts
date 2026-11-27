export type Backend = { provider: "webgpu" | "wasm"; threads: number };

export type BrowserCapabilities = {
  gpu?:
    | {
        requestAdapter(): Promise<{
          features: { has(name: string): boolean };
        } | null>;
      }
    | undefined;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
};

export async function backendCandidates({
  gpu,
  crossOriginIsolated,
  hardwareConcurrency,
}: BrowserCapabilities): Promise<Backend[]> {
  const threads = crossOriginIsolated
    ? Math.max(1, Math.floor(hardwareConcurrency) || 1)
    : 1;
  const wasm: Backend[] = [{ provider: "wasm", threads }];
  if (threads > 1) wasm.push({ provider: "wasm", threads: 1 });
  try {
    const adapter = await gpu?.requestAdapter();
    if (adapter?.features.has("shader-f16"))
      return [{ provider: "webgpu", threads }, ...wasm];
  } catch {
    return wasm;
  }
  return wasm;
}

export async function openBackend<T>(
  candidates: Backend[],
  open: (backend: Backend) => Promise<T>,
): Promise<{ backend: Backend; session: T }> {
  let error: unknown;
  for (const backend of candidates) {
    try {
      return { backend, session: await open(backend) };
    } catch (cause) {
      error = cause;
    }
  }
  throw error;
}

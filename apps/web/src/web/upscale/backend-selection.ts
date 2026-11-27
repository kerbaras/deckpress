export type Backend = { provider: "webgpu" | "wasm"; threads: number };

export type BrowserCapabilities = {
  gpu?: { requestAdapter(): Promise<unknown> } | undefined;
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
  const wasm: Backend = { provider: "wasm", threads };
  try {
    if (await gpu?.requestAdapter())
      return [{ provider: "webgpu", threads }, wasm];
  } catch {
    return [wasm];
  }
  return [wasm];
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

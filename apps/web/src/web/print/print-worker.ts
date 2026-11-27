import { PrintError, print } from "./pipeline.ts";
import type { PrintRequest, PrintResponse } from "./protocol.ts";

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ request: PrintRequest; base: string }>,
  ) => void;
  postMessage(response: PrintResponse): void;
};

scope.onmessage = async ({ data: { request, base } }) => {
  console.debug("[deckpress:print] request received", request.kind);
  scope.postMessage({ kind: "init", stage: "core", ready: false });
  try {
    const result = await print(request, new URL(base), (event) =>
      scope.postMessage(event),
    );
    scope.postMessage({ kind: "result", result });
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof PrintError ? { target: error.target } : {}),
    });
  }
};

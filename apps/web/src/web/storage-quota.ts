export async function storageQuotaError(error: unknown) {
  if (!(error instanceof DOMException) || error.name !== "QuotaExceededError")
    return error;
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const size = (bytes: number) =>
    (bytes / 1_000_000).toLocaleString(undefined, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    });
  const used =
    estimate?.usage == null
      ? "Browser storage usage is unavailable."
      : `Using about ${size(estimate.usage)}${estimate.quota == null ? "" : ` of ${size(estimate.quota)}`}.`;
  return new Error(
    `Browser storage is full. ${used} Go to Settings → Browser storage → Clear cache, then try again.`,
    { cause: error },
  );
}

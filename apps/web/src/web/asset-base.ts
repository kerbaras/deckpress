export const webAssetBase = () =>
  new URL(import.meta.env.BASE_URL, location.href);

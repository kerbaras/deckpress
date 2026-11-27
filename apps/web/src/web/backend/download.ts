const formats = {
  json: {
    mime: "application/json",
    limit: 64 * 1024 * 1024,
    label: "Deck backup",
  },
  xml: {
    mime: "application/xml",
    limit: 512 * 1024,
    label: "MPC Autofill order",
  },
};

export function downloadText(
  destination: string,
  contents: string,
  extension: keyof typeof formats,
) {
  const { mime, limit, label } = formats[extension];
  if (!destination.endsWith(`.${extension}`))
    throw new Error(`Save the ${label} as a .${extension} file.`);
  const blob = new Blob([contents], { type: mime });
  if (blob.size > limit) throw new Error(`${label} is too large to save.`);
  return downloadBlob(destination, blob);
}

export function downloadBlob(destination: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = destination;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return null;
}

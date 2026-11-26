import type { Art } from "./core/index.ts";

export function scanLabel(art: Art): string {
  if (art.provider !== "scryfall")
    return art.provider === "mpc" ? `MPC · ${art.dpi} DPI` : "Uploaded source";
  switch (art.scanQuality) {
    case "highres_scan":
      return "High-res scan";
    case "lowres":
      return "Low-res scan";
    case "placeholder":
      return "Placeholder";
    case "missing":
      return "Missing scan";
    default:
      return "Scan quality unknown";
  }
}

export function ScanQualityBadge({ art }: { art: Art }) {
  return <span className="badge scan-quality">{scanLabel(art)}</span>;
}

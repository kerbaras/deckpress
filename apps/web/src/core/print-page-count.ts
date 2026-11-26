import type { PrintSettings } from "./models.ts";

export function printPageCount(
  selectedSheets: number,
  { backs, calibrationPage }: Pick<PrintSettings, "backs" | "calibrationPage">,
) {
  const duplex = backs === "long-edge" || backs === "short-edge";
  const calibrationPages =
    selectedSheets > 0 && calibrationPage ? (duplex ? 2 : 1) : 0;
  const pdfPages =
    selectedSheets * (backs === "none" ? 1 : 2) + calibrationPages;
  return { pdfPages, calibrationPages };
}

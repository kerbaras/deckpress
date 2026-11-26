import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { StatusRegion } from "./ui.tsx";

it("re-inserts changed messages or ids without replacing the live region", () => {
  const { rerender } = render(
    <StatusRegion label="Export status">{""}</StatusRegion>,
  );
  const status = screen.getByRole("status", { name: "Export status" });
  expect(status).toBeEmptyDOMElement();

  const update = (message: string, announcementId: number) => {
    rerender(
      <StatusRegion label="Export status" announcementId={announcementId}>
        {message}
      </StatusRegion>,
    );
    expect(screen.getByRole("status", { name: "Export status" })).toBe(status);
    return status.firstElementChild;
  };
  const queued = update("Queued", 1);
  expect(queued).toHaveTextContent(/^Queued$/);
  const saved = update("Saved", 1);
  expect(saved).toHaveTextContent(/^Saved$/);
  expect(saved).not.toBe(queued);
  expect(update("Saved", 1)).toBe(saved);
  expect(update("Saved", 2)).not.toBe(saved);
  update("", 3);
  expect(status).toBeEmptyDOMElement();
});

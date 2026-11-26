import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Loading, StatusRegion, zoneLabel } from "./ui.tsx";

it("adds a keyed loading message to an already mounted region", () => {
  const { rerender } = render(<Loading active={false} />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  rerender(<Loading />);
  expect(
    screen.getAllByText(/^Loading…$/).find((node) => node.closest(".loading")),
  ).toBeVisible();
  const first = screen.getByRole("group");
  expect(first).toHaveTextContent(/^Loading…$/);
  rerender(<Loading />);
  expect(screen.getByRole("group")).toBe(first);
  rerender(<Loading>Searching…</Loading>);
  expect(screen.getByRole("status")).toBe(status);
  const next = screen.getByRole("group");
  expect(next).not.toBe(first);
  expect(next).toHaveTextContent(/^Searching…$/);
  rerender(<Loading active={false}>Searching…</Loading>);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.queryByText(/^Searching…$/)).not.toBeInTheDocument();
});

it("inserts the loading message even if a preview rerenders before its timer can run", () => {
  vi.useFakeTimers();
  try {
    const preview = (active: boolean, label: string) => (
      <>
        <h2>{label}</h2>
        <Loading active={active}>Loading decklist…</Loading>
      </>
    );
    const { rerender } = render(preview(true, "Deck preview"));
    const status = screen.getByRole("status");
    vi.setSystemTime(Date.now() + 10);
    rerender(preview(true, "Updated deck preview"));
    vi.setSystemTime(Date.now() + 45);
    expect(status.firstElementChild).toHaveTextContent("Loading decklist…");
    rerender(preview(false, "Decklist ready"));
    expect(
      screen.getByRole("heading", { name: "Decklist ready" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
    act(() => vi.runOnlyPendingTimers());
    expect(status).toBeEmptyDOMElement();
  } finally {
    vi.useRealTimers();
  }
});

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

it("announces only the message that survives the 50 ms coalescing window", () => {
  vi.useFakeTimers();
  try {
    const region = (text: string, id: number) => (
      <StatusRegion label="Job status" announcementId={id} coalesce>
        {text}
      </StatusRegion>
    );
    const { rerender } = render(region("Queued", 1));
    const status = screen.getByRole("status", { name: "Job status" });
    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });

    advance(30);
    expect(status).toBeEmptyDOMElement();
    rerender(region("Running", 2));
    advance(49);
    expect(status).toBeEmptyDOMElement();
    advance(1);
    const running = status.firstChild;
    expect(status).toHaveTextContent(/^Running$/);
    rerender(region("Running", 2));
    advance(50);
    expect(status.firstChild).toBe(running);
    rerender(region("Running", 3));
    advance(50);
    expect(status.firstChild).not.toBe(running);
    rerender(region("Completed", 4));
    rerender(region("", 5));
    advance(50);
    expect(status).toBeEmptyDOMElement();
  } finally {
    vi.useRealTimers();
  }
});

it("pluralizes the Companion board label by card count", () => {
  expect(zoneLabel("companion", 1)).toBe("Companion");
  expect(zoneLabel("companion", 2)).toBe("Companions");
  expect(zoneLabel("commander", 2)).toBe("Commander");
});

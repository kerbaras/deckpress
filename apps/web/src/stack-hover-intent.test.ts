import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStackHoverIntent } from "./stack-hover-intent.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("raises the first card immediately and waits 200 ms to hand off", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  expect(result.current.raisedId).toBeUndefined();
  act(() => result.current.onPointerEnterCard("opt"));
  expect(result.current.raisedId).toBe("opt");
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => vi.advanceTimersByTime(199));
  expect(result.current.raisedId).toBe("opt");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.raisedId).toBe("ponder");
});

it("replaces a pending handoff and cancels it when returning to the raised card", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  act(() => result.current.onPointerEnterCard("opt"));
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => vi.advanceTimersByTime(150));
  act(() => result.current.onPointerEnterCard("preordain"));
  act(() => vi.advanceTimersByTime(100));
  expect(result.current.raisedId).toBe("opt");
  act(() => result.current.onPointerEnterCard("opt"));
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.raisedId).toBe("opt");
});

it("cancels a delayed clear on stack re-entry and clears after a sustained leave", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  act(() => result.current.onPointerLeaveStack());
  expect(vi.getTimerCount()).toBe(0);
  act(() => result.current.onPointerEnterCard("opt"));
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => result.current.onPointerLeaveStack());
  act(() => vi.advanceTimersByTime(199));
  expect(result.current.raisedId).toBe("opt");
  act(() => result.current.onPointerEnterStack());
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.raisedId).toBe("opt");
  act(() => result.current.onPointerLeaveStack());
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.raisedId).toBeUndefined();
});

it("cleans up pending timers on unmount without affecting other stacks", () => {
  const first = renderHook(() => useStackHoverIntent());
  const second = renderHook(() => useStackHoverIntent());
  act(() => {
    first.result.current.onPointerEnterCard("opt");
    second.result.current.onPointerEnterCard("island");
    first.result.current.onPointerEnterCard("ponder");
  });
  expect(vi.getTimerCount()).toBe(1);
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(second.result.current.raisedId).toBe("island");
});

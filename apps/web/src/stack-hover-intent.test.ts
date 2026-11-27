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

it("raises keyboard focus immediately, then restores it after a pointer handoff and leave", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  act(() => result.current.onPointerEnterCard("preordain"));
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => result.current.onFocusCard("opt"));
  expect(result.current.raisedId).toBe("opt");
  expect(vi.getTimerCount()).toBe(0);

  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => vi.advanceTimersByTime(199));
  expect(result.current.raisedId).toBe("opt");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.raisedId).toBe("ponder");

  act(() => result.current.onPointerLeaveStack());
  act(() => vi.advanceTimersByTime(199));
  expect(result.current.raisedId).toBe("ponder");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.raisedId).toBe("opt");
  act(() => result.current.onBlurCard("opt"));
  expect(result.current.raisedId).toBeUndefined();
});

it("does not restore a card that lost keyboard focus during a hover raise", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  act(() => result.current.onFocusCard("opt"));
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => vi.advanceTimersByTime(200));
  act(() => result.current.onBlurCard("opt"));
  expect(result.current.raisedId).toBe("ponder");
  act(() => result.current.onPointerLeaveStack());
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.raisedId).toBeUndefined();
});

it("cancels a handoff from keyboard focus when the pointer leaves before it fires", () => {
  const { result } = renderHook(() => useStackHoverIntent());
  act(() => result.current.onFocusCard("opt"));
  act(() => result.current.onPointerEnterCard("ponder"));
  act(() => result.current.onPointerLeaveStack());
  expect(vi.getTimerCount()).toBe(0);
  expect(result.current.raisedId).toBe("opt");
});

it("recovers a hover raise without pointerleave and observes re-entry without restarting the clear timer", () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const stack = document.createElement("div");
  const child = stack.appendChild(document.createElement("button"));
  document.body.append(stack);
  const { result, unmount } = renderHook(() => useStackHoverIntent());
  result.current.stackRef.current = stack;

  const move = (target: HTMLElement, type = "pointermove") =>
    act(() => target.dispatchEvent(new Event(type, { bubbles: true })));
  try {
    act(() => result.current.onFocusCard("opt"));
    act(() => result.current.onPointerEnterCard("ponder"));
    act(() => vi.advanceTimersByTime(200));
    const listener = add.mock.calls.find(
      ([type]) => type === "pointermove",
    )?.[1];
    expect(add).toHaveBeenCalledWith("pointermove", listener, {
      passive: true,
    });
    expect(add).toHaveBeenCalledWith("pointerover", listener, {
      passive: true,
    });

    move(document.body);
    act(() => vi.advanceTimersByTime(199));
    move(child, "pointerover");
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.raisedId).toBe("ponder");

    move(document.body, "pointerover");
    act(() => vi.advanceTimersByTime(150));
    move(document.body);
    act(() => vi.advanceTimersByTime(49));
    expect(result.current.raisedId).toBe("ponder");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.raisedId).toBe("opt");
    expect(remove).toHaveBeenCalledWith("pointermove", listener);
    expect(remove).toHaveBeenCalledWith("pointerover", listener);

    act(() => result.current.onPointerEnterCard("opt"));
    const active = add.mock.calls.findLast(
      ([type]) => type === "pointermove",
    )?.[1];
    expect(active).not.toBe(listener);
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", active);
    expect(remove).toHaveBeenCalledWith("pointerover", active);
  } finally {
    stack.remove();
    add.mockRestore();
    remove.mockRestore();
  }
});

it.each(["blur", "hidden"] as const)(
  "clears hover and cancels pending handoffs on %s without discarding keyboard focus",
  (event) => {
    const { result } = renderHook(() => useStackHoverIntent());
    const hidden = vi.spyOn(document, "hidden", "get");
    const deactivate = () => {
      if (event === "blur") window.dispatchEvent(new Event("blur"));
      else document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      act(() => result.current.onPointerEnterCard("preordain"));
      act(() => result.current.onPointerEnterCard("ponder"));
      if (event === "hidden") {
        hidden.mockReturnValue(false);
        act(deactivate);
        expect(result.current.raisedId).toBe("preordain");
        expect(vi.getTimerCount()).toBe(1);
      }
      hidden.mockReturnValue(true);
      act(deactivate);
      expect(result.current.raisedId).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);

      act(() => result.current.onFocusCard("opt"));
      act(() => result.current.onPointerEnterCard("ponder"));
      act(() => vi.advanceTimersByTime(200));
      expect(result.current.raisedId).toBe("ponder");
      act(deactivate);
      expect(result.current.raisedId).toBe("opt");
    } finally {
      hidden.mockRestore();
    }
  },
);

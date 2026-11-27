import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export function useStackHoverIntent(delayMs = 200) {
  const [hoveredId, setHoveredId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const stackRef = useRef<HTMLDivElement>(null);
  const hovered = useRef<string>(undefined);
  const focused = useRef<string>(undefined);
  const timer = useRef<{
    handle: ReturnType<typeof setTimeout>;
    clear: boolean;
  }>(undefined);

  const cancelHandoff = useCallback(() => {
    clearTimeout(timer.current?.handle);
    timer.current = undefined;
  }, []);

  const raiseFromPointer = useCallback((id: string | undefined) => {
    hovered.current = id;
    setHoveredId(id);
  }, []);

  const scheduleHandoff = useCallback(
    (id: string | undefined) => {
      if (id === undefined && timer.current?.clear) return;
      cancelHandoff();
      timer.current = {
        handle: setTimeout(() => {
          timer.current = undefined;
          raiseFromPointer(id);
        }, delayMs),
        clear: id === undefined,
      };
    },
    [cancelHandoff, delayMs, raiseFromPointer],
  );

  const hoverActive = hoveredId !== undefined;
  useLayoutEffect(() => {
    if (!hoverActive || !stackRef.current) return;
    const stack = stackRef.current;
    function onDocumentPointer(event: PointerEvent) {
      if (hovered.current === undefined || !(event.target instanceof Node))
        return;
      if (stack.contains(event.target)) {
        if (timer.current?.clear) cancelHandoff();
      } else scheduleHandoff(undefined);
    }
    document.addEventListener("pointermove", onDocumentPointer, {
      passive: true,
    });
    document.addEventListener("pointerover", onDocumentPointer, {
      passive: true,
    });
    return () => {
      document.removeEventListener("pointermove", onDocumentPointer);
      document.removeEventListener("pointerover", onDocumentPointer);
    };
  }, [hoverActive, cancelHandoff, scheduleHandoff]);

  useEffect(() => {
    function clearHover() {
      cancelHandoff();
      raiseFromPointer(undefined);
    }

    function onVisibilityChange() {
      if (document.hidden) clearHover();
    }

    window.addEventListener("blur", clearHover);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", clearHover);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelHandoff();
    };
  }, [cancelHandoff, raiseFromPointer]);

  return {
    raisedId: hoveredId ?? focusedId,
    stackRef,
    onPointerEnterStack: cancelHandoff,
    onPointerEnterCard(id: string) {
      const current = hovered.current ?? focused.current;
      if (current === undefined || id === current) {
        cancelHandoff();
        raiseFromPointer(id);
      } else scheduleHandoff(id);
    },
    onPointerLeaveStack() {
      if (hovered.current !== undefined) scheduleHandoff(undefined);
      else cancelHandoff();
    },
    onFocusCard(id: string) {
      cancelHandoff();
      focused.current = id;
      setFocusedId(id);
      raiseFromPointer(undefined);
    },
    onBlurCard(id: string) {
      if (focused.current !== id) return;
      focused.current = undefined;
      setFocusedId(undefined);
    },
  };
}

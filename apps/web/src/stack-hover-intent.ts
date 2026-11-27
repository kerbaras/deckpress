import { useCallback, useEffect, useRef, useState } from "react";

export function useStackHoverIntent(delayMs = 200) {
  const [raisedId, setRaisedId] = useState<string>();
  const hovered = useRef<string>(undefined);
  const focused = useRef<string>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cancelHandoff = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const raiseFromPointer = useCallback((id: string | undefined) => {
    hovered.current = id;
    setRaisedId(id ?? focused.current);
  }, []);

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

  function scheduleHandoff(id: string | undefined) {
    cancelHandoff();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      raiseFromPointer(id);
    }, delayMs);
  }

  return {
    raisedId,
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
      raiseFromPointer(undefined);
    },
    onBlurCard(id: string) {
      if (focused.current !== id) return;
      focused.current = undefined;
      setRaisedId(hovered.current);
    },
  };
}

import { useEffect, useRef, useState } from "react";

export function useStackHoverIntent(delayMs = 200) {
  const [raisedId, setRaisedId] = useState<string>();
  const raised = useRef<string>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function cancelHandoff() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function raise(id: string | undefined) {
    raised.current = id;
    setRaisedId(id);
  }

  function scheduleHandoff(id: string | undefined) {
    cancelHandoff();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      raise(id);
    }, delayMs);
  }

  return {
    raisedId,
    onPointerEnterStack: cancelHandoff,
    onPointerEnterCard(id: string) {
      if (id === raised.current) cancelHandoff();
      else if (raised.current === undefined) raise(id);
      else scheduleHandoff(id);
    },
    onPointerLeaveStack() {
      if (raised.current !== undefined) scheduleHandoff(undefined);
    },
  };
}

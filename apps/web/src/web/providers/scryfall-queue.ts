const interval = 100;

interface Job {
  background: () => boolean;
  start: () => Promise<void>;
}

export function scryfallQueue() {
  const jobs = new Set<Job>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let next = 0;
  let retryAfterSeconds: number | undefined;

  function report(seconds: number | undefined) {
    if (retryAfterSeconds === seconds) return;
    retryAfterSeconds = seconds;
    for (const listener of listeners) listener();
  }

  function defer(delay: number) {
    next = Math.max(next, performance.now() + delay);
  }

  function dispatch() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (running) return;
    if (!jobs.size) {
      report(undefined);
      return;
    }
    const delay = next - performance.now();
    if (delay > 0) {
      if (delay > interval) report(Math.ceil(delay / 1000));
      timer = setTimeout(dispatch, Math.min(Math.ceil(delay), 2_147_483_647));
      return;
    }
    const job =
      [...jobs].find((item) => !item.background()) ??
      jobs.values().next().value;
    if (!job) return;
    jobs.delete(job);
    running = true;
    defer(interval);
    report(undefined);
    void job.start().finally(() => {
      running = false;
      dispatch();
    });
  }

  function enqueue<T>(
    signal: AbortSignal,
    background: () => boolean,
    send: () => Promise<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const job = {
        background,
        async start() {
          signal.removeEventListener("abort", abort);
          try {
            signal.throwIfAborted();
            resolve(await send());
          } catch (error) {
            reject(error);
          }
        },
      };
      function abort() {
        jobs.delete(job);
        reject(signal.reason);
        dispatch();
      }
      signal.addEventListener("abort", abort, { once: true });
      jobs.add(job);
      dispatch();
    });
  }

  return {
    defer,
    enqueue,
    getSnapshot: () => retryAfterSeconds,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

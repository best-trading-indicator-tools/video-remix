/** Share a one-time setup across previews and exports, with independent cancellation. */
export function createLamaSetup(install: (signal: AbortSignal, report: (phase: string) => void) => Promise<void>) {
  type Attempt = { controller: AbortController; promise: Promise<void>; listeners: Set<(phase: string) => void>; users: number };
  let attempt: Attempt | undefined;
  let ready = false;
  let phase = "";
  const ensure = async (signal: AbortSignal, onPhase: (phase: string) => void = () => {}) => {
    signal.throwIfAborted();
    if (ready) return;
    // Let a cancelled installer finish releasing its files before a retry starts.
    if (attempt?.controller.signal.aborted) {
      await attempt.promise.catch(() => {});
      return ensure(signal, onPhase);
    }
    if (!attempt) {
      const current: Attempt = { controller: new AbortController(), promise: Promise.resolve(), listeners: new Set(), users: 0 };
      attempt = current;
      phase = "Checking local LaMa";
      current.promise = Promise.resolve().then(() => install(current.controller.signal, next => {
        phase = next;
        for (const listener of current.listeners) listener(next);
      })).then(() => { current.controller.signal.throwIfAborted(); ready = true; }).finally(() => { attempt = undefined; phase = ""; });
    }
    const current = attempt;
    current.users++;
    current.listeners.add(onPhase);
    onPhase(phase);
    let abort!: () => void;
    try {
      await Promise.race([current.promise, new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
      current.listeners.delete(onPhase);
      if (--current.users === 0 && attempt === current) current.controller.abort();
    }
  };
  return { ensure, status: () => ({ busy: !!attempt, phase }),
    invalidate: () => { ready = false; },
    stop: async () => { attempt?.controller.abort(); await attempt?.promise.catch(() => {}); } };
}

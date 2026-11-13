/**
 * Issue #576 (D-576-06) — the dashboard refreshes calmly: at most every 30 s, never while the tab
 * is hidden, and once right away when the reader comes back. One run at a time: a refresh that is
 * still running is not started a second time.
 */
export const DASHBOARD_POLL_INTERVAL_MS = 30_000;

/** Starts polling `refresh`; returns the stop function (clears the timer and the listener). */
export function startVisiblePoll(
  refresh: () => Promise<unknown> | void,
  intervalMs: number = DASHBOARD_POLL_INTERVAL_MS,
  doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick() {
    if (running || doc.hidden) return;
    running = true;
    try {
      await refresh();
    } catch {
      // a failed refresh is retried on the next tick; the page keeps its last data
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer === undefined) timer = setInterval(() => void tick(), intervalMs);
  }
  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function onVisibility() {
    if (doc.hidden) {
      stop();
    } else {
      void tick();
      start();
    }
  }

  doc.addEventListener("visibilitychange", onVisibility);
  if (!doc.hidden) start();
  return () => {
    stop();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

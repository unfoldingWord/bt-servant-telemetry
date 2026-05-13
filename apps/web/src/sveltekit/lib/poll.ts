/**
 * Visibility-aware interval poller. Fires `fn` every `intervalMs`, but
 * stops the timer entirely while the tab is hidden — no CPU burn on
 * background tabs. When the tab comes back into focus, `fn` fires once
 * immediately to catch up before the interval resumes.
 *
 * Caller is responsible for an initial fetch before starting the poller
 * if first-paint should not wait `intervalMs`.
 */

export type Poller = {
  dispose: () => void;
};

export function createPoller(fn: () => Promise<void> | void, intervalMs: number): Poller {
  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void fn();
    }, intervalMs);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function onVisibility(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      void fn();
      start();
    } else {
      stop();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  start();

  return {
    dispose(): void {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}

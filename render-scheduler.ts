export interface RenderScheduler {
  schedule(delayMs?: number): void;
  cancel(): void;
}

export function createRenderScheduler(render: () => void, defaultDelayMs: number): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledAt = 0;

  return {
    schedule(delayMs = defaultDelayMs) {
      const now = Date.now();
      const targetTime = now + delayMs;

      if (timer && scheduledAt <= targetTime) {
        return;
      }

      if (timer) {
        clearTimeout(timer);
      }

      scheduledAt = targetTime;
      timer = setTimeout(() => {
        timer = null;
        scheduledAt = 0;
        render();
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        scheduledAt = 0;
      }
    },
  };
}

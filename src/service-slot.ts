export type ServiceSlotLimiter = <T>(task: () => Promise<T>) => Promise<T>;

export async function runWithServiceSlot<T>(
  limiter: ServiceSlotLimiter,
  options: {
    beforeStart?: () => Promise<void>;
    task: () => Promise<T>;
  }
): Promise<T> {
  return limiter(async () => {
    if (options.beforeStart) {
      await options.beforeStart();
    }
    return options.task();
  });
}

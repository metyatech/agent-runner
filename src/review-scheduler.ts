import type { IdleEngine } from "./runner.js";
import type { ReviewQueueEntry } from "./review-queue.js";

export type ScheduledReviewFollowup = ReviewQueueEntry & {
  engine: IdleEngine;
};

export function scheduleReviewFollowups(options: {
  normalRunning: number;
  concurrency: number;
  allowedEngines: IdleEngine[];
  queue: ReviewQueueEntry[];
}): ScheduledReviewFollowup[] {
  const spare = Math.max(0, options.concurrency - Math.max(0, options.normalRunning));
  if (spare <= 0) {
    return [];
  }
  const selected = options.queue.slice(0, spare);
  if (options.allowedEngines.length === 0) {
    return selected
      .filter((entry) => !entry.requiresEngine)
      .map((entry) => ({
        ...entry,
        engine: "codex"
      }));
  }

  return selected.map((entry, index) => ({
    ...entry,
    engine: options.allowedEngines[index % options.allowedEngines.length]
  }));
}

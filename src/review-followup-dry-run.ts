import type { IdleEngine } from "./runner.js";
import type { ReviewQueueEntry } from "./review-queue.js";

export function planDryRunReviewFollowupQueue(options: {
  mergeOnlyBacklog: ReviewQueueEntry[];
  engineBacklog: ReviewQueueEntry[];
  maxEntries: number;
  allowedEngines: IdleEngine[];
}): ReviewQueueEntry[] {
  const maxEntries = Math.max(0, options.maxEntries);
  if (maxEntries === 0) {
    return [];
  }

  const mergeOnly = options.mergeOnlyBacklog.slice(0, maxEntries);
  const remaining = maxEntries - mergeOnly.length;
  if (remaining <= 0) {
    return mergeOnly;
  }

  if (options.allowedEngines.length === 0) {
    return mergeOnly;
  }

  return [...mergeOnly, ...options.engineBacklog.slice(0, remaining)];
}

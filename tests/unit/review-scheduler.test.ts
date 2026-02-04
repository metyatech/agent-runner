import { describe, expect, it } from "vitest";
import type { ReviewQueueEntry } from "../../src/review-queue.js";
import { scheduleReviewFollowups } from "../../src/review-scheduler.js";

describe("review-scheduler", () => {
  it("schedules up to spare capacity and assigns engines round-robin", () => {
    const queue: ReviewQueueEntry[] = [
      {
        issueId: 1,
        prNumber: 1,
        repo: { owner: "metyatech", repo: "a" },
        url: "x",
        reason: "review_comment",
        requiresEngine: true,
        enqueuedAt: new Date().toISOString()
      },
      {
        issueId: 2,
        prNumber: 2,
        repo: { owner: "metyatech", repo: "b" },
        url: "y",
        reason: "review_comment",
        requiresEngine: true,
        enqueuedAt: new Date().toISOString()
      }
    ];

    const scheduled = scheduleReviewFollowups({
      normalRunning: 1,
      concurrency: 2,
      allowedEngines: ["codex"],
      queue
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].issueId).toBe(1);
    expect(scheduled[0].engine).toBe("codex");
  });
});


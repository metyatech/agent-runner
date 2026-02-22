import { describe, expect, it } from "vitest";
import { planDryRunReviewFollowupQueue } from "../../src/review-followup-dry-run.js";
import type { ReviewQueueEntry } from "../../src/review-queue.js";

function createEntry(id: number, requiresEngine: boolean): ReviewQueueEntry {
  return {
    issueId: id,
    prNumber: id,
    repo: { owner: "metyatech", repo: "demo" },
    url: `https://example.com/pull/${id}`,
    reason: requiresEngine ? "review_comment" : "approval",
    requiresEngine,
    enqueuedAt: new Date(0).toISOString()
  };
}

describe("review-followup dry-run planning", () => {
  it("always includes merge-only entries first", () => {
    const mergeOnlyBacklog = [createEntry(1, false), createEntry(2, false)];
    const engineBacklog = [createEntry(3, true)];
    const queue = planDryRunReviewFollowupQueue({
      mergeOnlyBacklog,
      engineBacklog,
      maxEntries: 2,
      allowedEngines: ["codex"]
    });

    expect(queue.map((entry) => entry.issueId)).toEqual([1, 2]);
  });

  it("skips engine-required entries when no engines are allowed", () => {
    const mergeOnlyBacklog = [createEntry(1, false)];
    const engineBacklog = [createEntry(2, true), createEntry(3, true)];
    const queue = planDryRunReviewFollowupQueue({
      mergeOnlyBacklog,
      engineBacklog,
      maxEntries: 3,
      allowedEngines: []
    });

    expect(queue.map((entry) => entry.issueId)).toEqual([1]);
  });

  it("includes engine-required entries only after merge-only when engines are allowed", () => {
    const mergeOnlyBacklog = [createEntry(1, false)];
    const engineBacklog = [createEntry(2, true), createEntry(3, true)];
    const queue = planDryRunReviewFollowupQueue({
      mergeOnlyBacklog,
      engineBacklog,
      maxEntries: 3,
      allowedEngines: ["gemini-pro"]
    });

    expect(queue.map((entry) => entry.issueId)).toEqual([1, 2, 3]);
  });
});

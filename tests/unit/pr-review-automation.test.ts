import { describe, expect, it } from "vitest";
import { chooseMergeMethod, summarizeLatestReviews } from "../../src/pr-review-automation.js";

describe("pr-review-automation", () => {
  it("chooses preferred merge method based on repo settings", () => {
    expect(chooseMergeMethod({ allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: true })).toBe(
      "squash"
    );
    expect(chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: true, allowRebaseMerge: true })).toBe(
      "merge"
    );
    expect(chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: false, allowRebaseMerge: true })).toBe(
      "rebase"
    );
    expect(chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: false, allowRebaseMerge: false })).toBeNull();
  });

  it("summarizes approvals based on latest APPROVED/CHANGES_REQUESTED per reviewer", () => {
    const summary = summarizeLatestReviews(
      [
        { author: "alice", state: "APPROVED", submittedAt: "2026-02-04T00:00:00Z", body: null },
        { author: "bob", state: "COMMENTED", submittedAt: "2026-02-04T02:00:00Z", body: "Generated no new comments." }
      ],
      ["alice", "bob"]
    );

    expect(summary.approvals).toBe(1);
    expect(summary.okComments).toBe(1);
    expect(summary.changesRequested).toBe(0);
    expect(summary.actionableComments).toBe(0);
    expect(summary.pendingReviewers).toBe(0);
    expect(summary.approved).toBe(true);
  });

  it("blocks auto-merge when any latest review requests changes", () => {
    const summary = summarizeLatestReviews(
      [
        { author: "alice", state: "APPROVED", submittedAt: "2026-02-04T00:00:00Z", body: null },
        { author: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-02-04T00:00:00Z", body: "fix this" }
      ],
      ["alice", "bob"]
    );

    expect(summary.approvals).toBe(1);
    expect(summary.changesRequested).toBe(1);
    expect(summary.approved).toBe(false);
  });

  it("treats usage-limit style comments as non-actionable reviewer feedback", () => {
    const summary = summarizeLatestReviews(
      [
        {
          author: "copilot-pull-request-reviewer[bot]",
          state: "COMMENTED",
          submittedAt: "2026-02-04T00:00:00Z",
          body: "Usage limit reached. Unable to review now."
        }
      ],
      ["copilot-pull-request-reviewer[bot]"]
    );
    expect(summary.changesRequested).toBe(0);
    expect(summary.actionableComments).toBe(0);
    expect(summary.okComments).toBe(1);
    expect(summary.approved).toBe(true);
  });

  it("keeps merge blocked while some requested reviewers have not responded", () => {
    const summary = summarizeLatestReviews(
      [{ author: "alice", state: "APPROVED", submittedAt: "2026-02-04T00:00:00Z", body: null }],
      ["alice", "bob"]
    );
    expect(summary.pendingReviewers).toBe(1);
    expect(summary.approved).toBe(false);
  });
});

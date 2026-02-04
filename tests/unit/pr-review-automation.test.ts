import { describe, expect, it } from "vitest";
import { chooseMergeMethod, summarizeLatestReviews } from "../../src/pr-review-automation.js";

describe("pr-review-automation", () => {
  it("chooses preferred merge method based on repo settings", () => {
    expect(
      chooseMergeMethod({ allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: true })
    ).toBe("squash");
    expect(
      chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: true, allowRebaseMerge: true })
    ).toBe("merge");
    expect(
      chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: false, allowRebaseMerge: true })
    ).toBe("rebase");
    expect(
      chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: false, allowRebaseMerge: false })
    ).toBeNull();
  });

  it("summarizes approvals based on latest APPROVED/CHANGES_REQUESTED per reviewer", () => {
    const summary = summarizeLatestReviews([
      { author: "alice", state: "APPROVED", submittedAt: "2026-02-04T00:00:00Z" },
      { author: "alice", state: "COMMENTED", submittedAt: "2026-02-04T01:00:00Z" },
      { author: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-02-04T01:00:00Z" },
      { author: "bob", state: "APPROVED", submittedAt: "2026-02-04T02:00:00Z" }
    ]);

    expect(summary.approvals).toBe(2);
    expect(summary.changesRequested).toBe(false);
    expect(summary.approved).toBe(true);
  });

  it("blocks auto-merge when any latest review requests changes", () => {
    const summary = summarizeLatestReviews([
      { author: "alice", state: "APPROVED", submittedAt: "2026-02-04T00:00:00Z" },
      { author: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-02-04T00:00:00Z" }
    ]);

    expect(summary.approvals).toBe(1);
    expect(summary.changesRequested).toBe(true);
    expect(summary.approved).toBe(false);
  });
});


import { describe, expect, it } from "vitest";
import type { IssueComment } from "../../src/github.js";
import {
  REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER,
  REVIEW_FOLLOWUP_WAITING_MARKER,
  buildReviewFollowupActionRequiredComment,
  buildReviewFollowupWaitingComment,
  isManualActionRequiredForAutoMergeSkip,
  shouldPostReviewFollowupMarkerComment
} from "../../src/review-followup-status.js";

describe("review-followup-status", () => {
  describe("isManualActionRequiredForAutoMergeSkip", () => {
    it.each([
      "actionable_review_feedback",
      "not_approved",
      "no_merge_method_enabled",
      "merge_failed:unknown",
      "something_new"
    ])("returns true for manual-action reason %s", (reason) => {
      expect(isManualActionRequiredForAutoMergeSkip(reason)).toBe(true);
    });

    it.each([
      "already_merged",
      "pr_not_found",
      "pr_not_open:closed",
      "pr_not_open:merged",
      "PR_NOT_OPEN:CLOSED"
    ])("returns false for non-actionable terminal reason %s", (reason) => {
      expect(isManualActionRequiredForAutoMergeSkip(reason)).toBe(false);
    });
  });

  it("builds waiting comment with no-action guidance", () => {
    const comment = buildReviewFollowupWaitingComment({
      reason: "idle_engine_gates_blocked",
      queuedEngineFollowups: 3,
      updatedAtIso: "2026-02-16T04:00:00.000Z"
    });
    expect(comment).toContain(REVIEW_FOLLOWUP_WAITING_MARKER);
    expect(comment).toContain("No action required");
    expect(comment).toContain("queued follow-ups requiring engine: 3");
  });

  it("builds action-required comment with reason-specific guidance", () => {
    const comment = buildReviewFollowupActionRequiredComment({
      reason: "actionable_review_feedback",
      updatedAtIso: "2026-02-16T04:05:00.000Z"
    });
    expect(comment).toContain(REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER);
    expect(comment).toContain("Action required");
    expect(comment).toContain("Address requested PR feedback");
  });

  describe("shouldPostReviewFollowupMarkerComment", () => {
    it("returns true when marker does not exist", () => {
      const comments: IssueComment[] = [
        { id: 1, body: "hello", createdAt: "2026-02-16T03:00:00.000Z" }
      ];
      expect(shouldPostReviewFollowupMarkerComment(comments, REVIEW_FOLLOWUP_WAITING_MARKER)).toBe(
        true
      );
    });

    it("returns false when marker exists and no user reply after marker", () => {
      const comments: IssueComment[] = [
        {
          id: 1,
          body: `<!-- agent-runner -->\n${REVIEW_FOLLOWUP_WAITING_MARKER}\nwaiting`,
          createdAt: "2026-02-16T03:00:00.000Z"
        }
      ];
      expect(shouldPostReviewFollowupMarkerComment(comments, REVIEW_FOLLOWUP_WAITING_MARKER)).toBe(
        false
      );
    });

    it("returns true when user replied after marker", () => {
      const comments: IssueComment[] = [
        {
          id: 1,
          body: `<!-- agent-runner -->\n${REVIEW_FOLLOWUP_WAITING_MARKER}\nwaiting`,
          createdAt: "2026-02-16T03:00:00.000Z"
        },
        {
          id: 2,
          body: "Can I trigger it now?",
          createdAt: "2026-02-16T03:01:00.000Z"
        }
      ];
      expect(shouldPostReviewFollowupMarkerComment(comments, REVIEW_FOLLOWUP_WAITING_MARKER)).toBe(
        true
      );
    });
  });
});

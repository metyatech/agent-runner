import { describe, expect, it } from "vitest";
import type { IssueInfo, RepoInfo } from "../../src/github.js";
import {
  attemptAutoMergeApprovedPullRequest,
  reRequestAllReviewers,
  shouldAutoMergeRetryRequireEngine
} from "../../src/pr-review-actions.js";

function makeRepo(): RepoInfo {
  return { owner: "metyatech", repo: "demo" };
}

function makeIssue(repo: RepoInfo): IssueInfo {
  return {
    id: 1,
    number: 1,
    title: "PR",
    body: null,
    author: "agent-runner-bot[bot]",
    repo,
    labels: [],
    url: "https://github.com/metyatech/demo/pull/1",
    isPullRequest: true
  };
}

describe("pr-review-actions", () => {
  describe("shouldAutoMergeRetryRequireEngine", () => {
    it.each([
      "unresolved_review_threads",
      "not_mergeable:unstable",
      "not_mergeable:dirty",
      "merge_failed:head branch was modified"
    ])("returns true for fixable retry reason %s", (reason) => {
      expect(shouldAutoMergeRetryRequireEngine(reason)).toBe(true);
    });

    it.each([
      "awaiting_reviewer_feedback",
      "draft",
      "mergeable_unavailable",
      "review_threads_unavailable",
      "not_mergeable:blocked"
    ])("returns false for wait-only retry reason %s", (reason) => {
      expect(shouldAutoMergeRetryRequireEngine(reason)).toBe(false);
    });
  });

  it("re-requests prior reviewers (human/copilot/codex)", async () => {
    const repo = makeRepo();
    const issue = makeIssue(repo);
    const calls: {
      request: string[][];
      remove: string[][];
      comments: string[];
    } = { request: [], remove: [], comments: [] };

    const client = {
      listPullRequestReviews: async () => [
        {
          id: 1,
          author: "alice",
          state: "APPROVED",
          submittedAt: "2026-02-06T00:00:00Z",
          body: null
        },
        {
          id: 2,
          author: "copilot-pull-request-reviewer[bot]",
          state: "COMMENTED",
          submittedAt: "2026-02-06T00:01:00Z",
          body: "Generated no new comments."
        },
        {
          id: 3,
          author: "chatgpt-codex-connector[bot]",
          state: "COMMENTED",
          submittedAt: "2026-02-06T00:02:00Z",
          body: "Please review."
        }
      ],
      getPullRequest: async () => ({
        number: 1,
        url: issue.url,
        draft: false,
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        headRef: "x",
        headSha: "y",
        headRepoFullName: "metyatech/demo",
        requestedReviewerLogins: []
      }),
      requestPullRequestReviewers: async (
        _repo: RepoInfo,
        _pullNumber: number,
        reviewers: string[]
      ) => {
        calls.request.push(reviewers);
      },
      removeRequestedPullRequestReviewers: async (
        _repo: RepoInfo,
        _pullNumber: number,
        reviewers: string[]
      ) => {
        calls.remove.push(reviewers);
      },
      commentIssue: async (_repo: RepoInfo, _issueNumber: number, body: string) => {
        calls.comments.push(body);
      }
    };

    const result = await reRequestAllReviewers({
      client: client as any,
      repo,
      pullNumber: 1,
      issue
    });

    expect(result.requestedHumanReviewers).toEqual(["alice"]);
    expect(result.requestedCopilot).toBe(true);
    expect(result.requestedCodex).toBe(true);
    expect(calls.request).toEqual([["alice"], ["copilot-pull-request-reviewer[bot]"]]);
    expect(calls.remove).toEqual([["copilot-pull-request-reviewer[bot]"]]);
    expect(calls.comments).toEqual(["@codex review"]);
  });

  it("does not auto-merge while waiting for requested reviewers", async () => {
    const repo = makeRepo();
    const issue = makeIssue(repo);
    const client = {
      getPullRequest: async () => ({
        number: 1,
        url: issue.url,
        draft: false,
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        headRef: "x",
        headSha: "y",
        headRepoFullName: "metyatech/demo",
        requestedReviewerLogins: ["alice", "bob"]
      }),
      listPullRequestReviewThreads: async () => [],
      listPullRequestReviews: async () => [
        {
          id: 1,
          author: "alice",
          state: "APPROVED",
          submittedAt: "2026-02-06T00:00:00Z",
          body: null
        }
      ]
    };

    const result = await attemptAutoMergeApprovedPullRequest({
      client: client as any,
      repo,
      pullNumber: 1,
      issue
    });

    expect(result).toEqual({ merged: false, retry: true, reason: "awaiting_reviewer_feedback" });
  });

  it("does not auto-merge when actionable commented review exists", async () => {
    const repo = makeRepo();
    const issue = makeIssue(repo);
    const client = {
      getPullRequest: async () => ({
        number: 1,
        url: issue.url,
        draft: false,
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        headRef: "x",
        headSha: "y",
        headRepoFullName: "metyatech/demo",
        requestedReviewerLogins: ["alice"]
      }),
      listPullRequestReviewThreads: async () => [],
      listPullRequestReviews: async () => [
        {
          id: 1,
          author: "alice",
          state: "COMMENTED",
          submittedAt: "2026-02-06T00:00:00Z",
          body: "Please fix failing tests."
        }
      ]
    };

    const result = await attemptAutoMergeApprovedPullRequest({
      client: client as any,
      repo,
      pullNumber: 1,
      issue
    });

    expect(result).toEqual({ merged: false, retry: false, reason: "actionable_review_feedback" });
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunnerConfig } from "../../src/config.js";
import type { IssueInfo, PullRequestDetails, RepoInfo } from "../../src/github.js";
import { markManagedPullRequest, resolveManagedPullRequestsStatePath } from "../../src/managed-pull-requests.js";
import { enqueueManagedPullRequestReviewFollowups } from "../../src/managed-pr-review-catchup.js";
import { loadReviewQueue, resolveReviewQueuePath } from "../../src/review-queue.js";

function makeConfig(workdirRoot: string): AgentRunnerConfig {
  return {
    owner: "metyatech",
    repos: ["demo"],
    workdirRoot,
    pollIntervalSeconds: 60,
    concurrency: 1,
    labels: {
      queued: "agent:queued",
      running: "agent:running",
      done: "agent:done",
      failed: "agent:failed",
      needsUserReply: "agent:needs-user-reply"
    },
    codex: { command: "codex", args: [], promptTemplate: "" },
    idle: { enabled: true, maxRunsPerCycle: 1, cooldownMinutes: 60, tasks: [], promptTemplate: "" }
  };
}

function makeRepo(): RepoInfo {
  return { owner: "metyatech", repo: "demo" };
}

function makeIssue(repo: RepoInfo): IssueInfo {
  return {
    id: 101,
    number: 5,
    title: "PR",
    body: "Body",
    author: "metyatech",
    repo,
    labels: [],
    url: "https://github.com/metyatech/demo/pull/5",
    isPullRequest: true
  };
}

function makePullRequestDetails(): PullRequestDetails {
  return {
    number: 5,
    url: "https://github.com/metyatech/demo/pull/5",
    draft: false,
    state: "open",
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    headRef: "refs/heads/feature",
    headSha: "abc",
    headRepoFullName: "metyatech/demo",
    requestedReviewerLogins: []
  };
}

describe("managed-pr-review-catchup", () => {
  it("enqueues follow-ups for managed PRs even without agent:done label", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-catchup-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue = makeIssue(repo);

    const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    await markManagedPullRequest(managedStatePath, repo, issue.number);

    const client = {
      getIssue: async () => issue,
      getPullRequest: async () => makePullRequestDetails(),
      listPullRequestReviewThreads: async () => [{ id: "t1", isResolved: false, isOutdated: false }],
      listPullRequestReviews: async () => [],
      searchOpenPullRequestsByAuthorAcrossOwner: async () => []
    };

    const enqueued = await enqueueManagedPullRequestReviewFollowups({
      client: client as any,
      config,
      dryRun: false,
      maxEntries: 5
    });

    expect(enqueued).toBe(1);
    const queuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("review_comment");
    expect(queued[0]?.requiresEngine).toBe(true);
  });

  it("enqueues review follow-up when changes are requested", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-catchup-review-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue = makeIssue(repo);

    const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    await markManagedPullRequest(managedStatePath, repo, issue.number);

    const client = {
      getIssue: async () => issue,
      getPullRequest: async () => makePullRequestDetails(),
      listPullRequestReviewThreads: async () => [],
      listPullRequestReviews: async () => [
        {
          state: "CHANGES_REQUESTED",
          author: "reviewer",
          submittedAt: new Date().toISOString(),
          body: "Please address these issues."
        }
      ],
      searchOpenPullRequestsByAuthorAcrossOwner: async () => []
    };

    const enqueued = await enqueueManagedPullRequestReviewFollowups({
      client: client as any,
      config,
      dryRun: false,
      maxEntries: 5
    });

    expect(enqueued).toBe(1);
    const queuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("review");
    expect(queued[0]?.requiresEngine).toBe(true);
  });

  it("enqueues approval follow-up when the latest reviews are approved", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-catchup-approval-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue = makeIssue(repo);

    const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    await markManagedPullRequest(managedStatePath, repo, issue.number);

    const client = {
      getIssue: async () => issue,
      getPullRequest: async () => makePullRequestDetails(),
      listPullRequestReviewThreads: async () => [],
      listPullRequestReviews: async () => [
        {
          state: "APPROVED",
          author: "reviewer",
          submittedAt: new Date().toISOString(),
          body: "LGTM"
        }
      ],
      searchOpenPullRequestsByAuthorAcrossOwner: async () => []
    };

    const enqueued = await enqueueManagedPullRequestReviewFollowups({
      client: client as any,
      config,
      dryRun: false,
      maxEntries: 5
    });

    expect(enqueued).toBe(1);
    const queuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("approval");
    expect(queued[0]?.requiresEngine).toBe(false);
  });

  it("enqueues follow-ups for agent-runner GitHub App bot PRs even when managed state is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-catchup-app-bot-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue: IssueInfo = { ...makeIssue(repo), author: "agent-runner-bot" };

    const client = {
      getIssue: async () => issue,
      getPullRequest: async () => makePullRequestDetails(),
      listPullRequestReviewThreads: async () => [{ id: "t1", isResolved: false, isOutdated: false }],
      listPullRequestReviews: async () => [],
      searchOpenPullRequestsByAuthorAcrossOwner: async (_owner: string, author: string) =>
        author === "agent-runner-bot" ? [issue] : []
    };

    const enqueued = await enqueueManagedPullRequestReviewFollowups({
      client: client as any,
      config,
      dryRun: false,
      maxEntries: 5
    });

    expect(enqueued).toBe(1);
    const queuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("review_comment");
    expect(queued[0]?.requiresEngine).toBe(true);
  });
});

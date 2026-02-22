import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunnerConfig } from "../../src/config.js";
import type { IssueInfo, RepoInfo } from "../../src/github.js";
import { resolveManagedPullRequestsStatePath } from "../../src/managed-pull-requests.js";
import { handleWebhookEvent } from "../../src/webhook-handler.js";
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
      reviewFollowup: "agent:review-followup",
      running: "agent:running",
      done: "agent:done",
      failed: "agent:failed",
      needsUserReply: "agent:needs-user"
    },
    codex: { command: "codex", args: [], promptTemplate: "" },
    idle: {
      enabled: true,
      maxRunsPerCycle: 1,
      cooldownMinutes: 60,
      tasks: [],
      promptTemplate: ""
    }
  };
}

function makeRepo(): RepoInfo {
  return { owner: "metyatech", repo: "demo" };
}

function makePullRequestIssue(repo: RepoInfo): IssueInfo {
  return {
    id: 101,
    number: 5,
    title: "PR",
    body: "Body",
    author: "agent-runner-bot[bot]",
    repo,
    labels: [],
    url: "https://github.com/metyatech/demo/pull/5",
    isPullRequest: true
  };
}

describe("webhook-handler review followup", () => {
  it("enqueues managed PRs on review comments (non /agent run)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-review-followup-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const calls: { addLabels: string[][]; removeLabels: string[] } = {
      addLabels: [],
      removeLabels: []
    };
    const client = {
      addLabels: async (_issue: IssueInfo, labels: string[]) => {
        calls.addLabels.push(labels);
      },
      removeLabel: async (_issue: IssueInfo, label: string) => {
        calls.removeLabels.push(label);
      },
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "z",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          comment: {
            id: 9003,
            body: "Please address this review comment.",
            author_association: "NONE",
            user: { login: "metyatech" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    expect(calls.addLabels.flat()).toContain("agent:review-followup");
    expect(calls.removeLabels).toContain("agent:review-followup:waiting");
    expect(calls.removeLabels).toContain("agent:review-followup:action-required");
    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    expect(loadReviewQueue(reviewQueuePath)).toHaveLength(1);
  });

  it("enqueues review follow-up for non-Copilot bot comments too", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-runner-webhook-any-bot-review-comment-")
    );
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "z",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          comment: {
            id: 9005,
            body: "Please fix this.",
            author_association: "NONE",
            user: { login: "chatgpt-codex-connector[bot]", type: "Bot" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(reviewQueuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("review_comment");
    expect(queued[0]?.requiresEngine).toBe(true);
  });

  it("treats Copilot 'no new comments' review as approval (merge-only follow-up)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-copilot-approval-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review",
        delivery: "z",
        payload: {
          action: "submitted",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          review: {
            id: 42,
            state: "commented",
            body: "Copilot reviewed the PR and generated no comments.",
            author_association: "NONE",
            user: { login: "copilot-pull-request-reviewer", type: "Bot" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(reviewQueuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("approval");
    expect(queued[0]?.requiresEngine).toBe(false);
  });

  it("enqueues engine follow-up for Copilot inline review comments", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-runner-webhook-copilot-review-comment-")
    );
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "z",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          comment: {
            id: 9004,
            body: "Copilot review comment.",
            author_association: "NONE",
            user: { login: "copilot-pull-request-reviewer", type: "Bot" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(reviewQueuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("review_comment");
    expect(queued[0]?.requiresEngine).toBe(true);
  });

  it("treats usage-limit review comments as approval follow-up", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-runner-webhook-usage-limit-review-comment-")
    );
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "z",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          comment: {
            id: 9006,
            body: "Usage limit reached. Unable to review now.",
            author_association: "NONE",
            user: { login: "any-review-bot", type: "Bot" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(reviewQueuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("approval");
    expect(queued[0]?.requiresEngine).toBe(false);
  });

  it("treats usage-limit pull_request_review bodies as approval follow-up", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-usage-limit-review-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review",
        delivery: "z",
        payload: {
          action: "submitted",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          review: {
            id: 77,
            state: "commented",
            body: "Quota exceeded. Cannot review right now.",
            author_association: "NONE",
            user: { login: "review-bot", type: "Bot" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    const queued = loadReviewQueue(reviewQueuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("approval");
    expect(queued[0]?.requiresEngine).toBe(false);
  });

  it("continues even when managed PR state is corrupted", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-runner-webhook-managed-state-corrupt-")
    );
    const config = makeConfig(root);
    const repo = makeRepo();
    const pr = makePullRequestIssue(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    fs.mkdirSync(path.dirname(managedStatePath), { recursive: true });
    fs.writeFileSync(managedStatePath, "{not-valid-json", "utf8");

    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async () => {},
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === pr.number ? pr : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "z",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: pr.number, id: pr.id, html_url: pr.url },
          comment: {
            id: 9010,
            body: "Please address this review comment.",
            author_association: "NONE",
            user: { login: "metyatech" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
    expect(loadReviewQueue(reviewQueuePath)).toHaveLength(1);
  });
});

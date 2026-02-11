import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunnerConfig } from "../../src/config.js";
import type { IssueInfo, RepoInfo } from "../../src/github.js";
import { handleWebhookEvent } from "../../src/webhook-handler.js";
import { loadWebhookQueue } from "../../src/webhook-queue.js";

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
      needsUserReply: "agent:needs-user"
    },
    codex: { command: "codex", args: [], promptTemplate: "" }
  };
}

function makeRepo(): RepoInfo {
  return { owner: "metyatech", repo: "demo" };
}

function makeIssueInfo(repo: RepoInfo): IssueInfo {
  return {
    id: 101,
    number: 5,
    title: "Test",
    body: "Body",
    author: "metyatech",
    repo,
    labels: [],
    url: "https://github.com/metyatech/demo/issues/5",
    isPullRequest: false
  };
}

describe("webhook-handler /agent run", () => {
  it("queues an issue comment /agent run (including PR issues)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-agent-run-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue = makeIssueInfo(repo);
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const calls: { addLabels: string[][]; removeLabel: string[]; comments: string[] } = {
      addLabels: [],
      removeLabel: [],
      comments: []
    };

    const client = {
      addLabels: async (_issue: IssueInfo, labels: string[]) => {
        calls.addLabels.push(labels);
      },
      removeLabel: async (_issue: IssueInfo, label: string) => {
        calls.removeLabel.push(label);
      },
      comment: async (_issue: IssueInfo, body: string) => {
        calls.comments.push(body);
      },
      listIssueComments: async () => [],
      getIssue: async () => issue
    };

    await handleWebhookEvent({
      event: {
        event: "issue_comment",
        delivery: "x",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          issue: {
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            html_url: issue.url,
            user: { login: issue.author },
            labels: [],
            pull_request: {}
          },
          comment: {
            id: 9001,
            body: "/agent run",
            author_association: "OWNER",
            user: { login: "metyatech" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    expect(calls.addLabels.flat()).toContain(config.labels.queued);
    expect(calls.comments.length).toBeGreaterThan(0);
    expect(loadWebhookQueue(queuePath)).toHaveLength(1);

    const managedPath = path.join(root, "agent-runner", "state", "managed-pull-requests.json");
    const managed = JSON.parse(fs.readFileSync(managedPath, "utf8")) as { managedPullRequests?: string[] };
    expect(managed.managedPullRequests ?? []).toContain("metyatech/demo#5");
  });

  it("queues a PR review comment /agent run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-agent-run-review-"));
    const config = makeConfig(root);
    const repo = makeRepo();
    const issue = { ...makeIssueInfo(repo), isPullRequest: true, url: "https://github.com/metyatech/demo/pull/5" };
    const queuePath = path.join(root, "agent-runner", "state", "webhook-queue.json");

    const calls: { comments: string[] } = { comments: [] };
    const client = {
      addLabels: async () => {},
      removeLabel: async () => {},
      comment: async (_issue: IssueInfo, body: string) => {
        calls.comments.push(body);
      },
      listIssueComments: async () => [],
      getIssue: async (_repo: RepoInfo, number: number) => (number === issue.number ? issue : null)
    };

    await handleWebhookEvent({
      event: {
        event: "pull_request_review_comment",
        delivery: "y",
        payload: {
          action: "created",
          repository: { name: repo.repo, owner: { login: repo.owner } },
          pull_request: { number: issue.number, id: issue.id, html_url: issue.url },
          comment: {
            id: 9002,
            body: "please\n/agent run\nthanks",
            author_association: "COLLABORATOR",
            user: { login: "someone" }
          }
        }
      },
      client: client as any,
      config,
      queuePath
    });

    expect(calls.comments.length).toBeGreaterThan(0);
    expect(loadWebhookQueue(queuePath)).toHaveLength(1);

    const managedPath = path.join(root, "agent-runner", "state", "managed-pull-requests.json");
    const managed = JSON.parse(fs.readFileSync(managedPath, "utf8")) as { managedPullRequests?: string[] };
    expect(managed.managedPullRequests ?? []).toContain("metyatech/demo#5");
  });
});

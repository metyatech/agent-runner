import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunnerConfig } from "../../src/config.js";
import type { IssueInfo } from "../../src/github.js";
import { ensureManagedPullRequestRecorded, isManagedPullRequestIssue } from "../../src/managed-pr.js";
import { markManagedPullRequest, resolveManagedPullRequestsStatePath } from "../../src/managed-pull-requests.js";

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
    codex: { command: "codex", args: [], promptTemplate: "" }
  };
}

function makePullRequestIssue(options: { author: string | null; number?: number; id?: number }): IssueInfo {
  return {
    id: options.id ?? 101,
    number: options.number ?? 5,
    title: "PR",
    body: "Body",
    author: options.author,
    repo: { owner: "metyatech", repo: "demo" },
    labels: [],
    url: "https://github.com/metyatech/demo/pull/5",
    isPullRequest: true
  };
}

describe("managed-pr", () => {
  it("treats agent-runner bot-authored PRs as managed even when state is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-bot-"));
    const config = makeConfig(root);
    const issue = makePullRequestIssue({ author: "agent-runner-app[bot]" });
    await expect(isManagedPullRequestIssue(issue, config)).resolves.toBe(true);
  });

  it("treats agent-runner GitHub App bot-authored PRs as managed even when state is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-app-bot-"));
    const config = makeConfig(root);
    await expect(isManagedPullRequestIssue(makePullRequestIssue({ author: "agent-runner-bot" }), config)).resolves.toBe(true);
    await expect(isManagedPullRequestIssue(makePullRequestIssue({ author: "app/agent-runner-bot" }), config)).resolves.toBe(true);
  });

  it("treats state-recorded PRs as managed even when author is not an agent-runner bot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-state-"));
    const config = makeConfig(root);
    const issue = makePullRequestIssue({ author: "metyatech" });
    const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    await markManagedPullRequest(statePath, issue.repo, issue.number);
    await expect(isManagedPullRequestIssue(issue, config)).resolves.toBe(true);
  });

  it("records agent-runner bot-authored PRs into managed state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-record-"));
    const config = makeConfig(root);
    const issue = makePullRequestIssue({ author: "agent-runner-app[bot]" });
    await expect(ensureManagedPullRequestRecorded(issue, config)).resolves.toBe(true);

    const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as { managedPullRequests?: string[] };
    expect(parsed.managedPullRequests ?? []).toContain("metyatech/demo#5");
  });

  it("does not record non-bot PRs when they are not already managed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-managed-pr-no-record-"));
    const config = makeConfig(root);
    const issue = makePullRequestIssue({ author: "metyatech" });
    await expect(ensureManagedPullRequestRecorded(issue, config)).resolves.toBe(false);

    const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

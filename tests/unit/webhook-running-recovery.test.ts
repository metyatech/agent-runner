import { describe, expect, it } from "vitest";
import type { AgentRunnerConfig } from "../../src/config.js";
import type { IssueInfo, RepoInfo } from "../../src/github.js";
import type { RunnerState } from "../../src/runner-state.js";
import { planWebhookRunningRecoveries } from "../../src/webhook-running-recovery.js";

function makeConfig(repos: AgentRunnerConfig["repos"]): AgentRunnerConfig {
  return {
    owner: "metyatech",
    repos,
    workdirRoot: "D:\\ghws",
    pollIntervalSeconds: 60,
    concurrency: 1,
    labels: {
      queued: "agent:queued",
      reviewFollowup: "agent:review-followup",
      running: "agent:running",
      done: "agent:done",
      failed: "agent:failed",
      needsUserReply: "agent:needs-user-reply"
    },
    codex: {
      command: "codex",
      args: [],
      promptTemplate: ""
    }
  };
}

function makeRepo(repo: string): RepoInfo {
  return { owner: "metyatech", repo };
}

function makeIssue(id: number, repo: RepoInfo): IssueInfo {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: null,
    author: "metyatech",
    repo,
    labels: ["agent:running"],
    url: `https://github.com/${repo.owner}/${repo.repo}/issues/${id}`,
    isPullRequest: false
  };
}

describe("planWebhookRunningRecoveries", () => {
  it("plans missing_state recovery when running label exists without local state", () => {
    const issue = makeIssue(4, makeRepo("vscode-monitor"));
    const state: RunnerState = { running: [] };

    const planned = planWebhookRunningRecoveries({
      issuesWithRunningLabel: [issue],
      state,
      config: makeConfig("all"),
      aliveCheck: () => true
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]).toEqual({
      issue,
      reason: "missing_state"
    });
  });

  it("plans dead_process recovery with pid when state exists but process is dead", () => {
    const issue = makeIssue(8, makeRepo("code-preview"));
    const state: RunnerState = {
      running: [
        {
          issueId: issue.id,
          issueNumber: issue.number,
          repo: issue.repo,
          startedAt: "2026-02-13T14:27:25.000Z",
          pid: 12345,
          logPath: "D:\\ghws\\agent-runner\\logs\\code-preview-issue-8.log"
        }
      ]
    };

    const planned = planWebhookRunningRecoveries({
      issuesWithRunningLabel: [issue],
      state,
      config: makeConfig("all"),
      aliveCheck: () => false
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]).toEqual({
      issue,
      reason: "dead_process",
      pid: 12345
    });
  });

  it("does not plan recovery for repositories outside config.repos scope", () => {
    const issue = makeIssue(12, makeRepo("out-of-scope"));
    const state: RunnerState = { running: [] };

    const planned = planWebhookRunningRecoveries({
      issuesWithRunningLabel: [issue],
      state,
      config: makeConfig(["agent-runner"]),
      aliveCheck: () => true
    });

    expect(planned).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { IssueInfo } from "../../src/github.js";
import { recoverStalledIssue } from "../../src/stalled-issue-recovery.js";

function createIssue(): IssueInfo {
  return {
    id: 42,
    number: 2,
    title: "test",
    body: null,
    author: "metyatech",
    repo: { owner: "metyatech", repo: "demo" },
    labels: ["agent:running"],
    url: "https://github.com/metyatech/demo/issues/2",
    isPullRequest: false
  };
}

describe("recoverStalledIssue", () => {
  it("does not mutate state in dry-run mode", async () => {
    const issue = createIssue();
    const addLabel = vi.fn(async () => {});
    const removeLabel = vi.fn(async () => {});
    const enqueueWebhookIssue = vi.fn(async () => false);
    const removeRunningIssue = vi.fn();
    const removeActivity = vi.fn();
    const clearRetry = vi.fn();
    const log = vi.fn();

    await recoverStalledIssue({
      issue,
      reason: "dead_process",
      pid: 1234,
      dryRun: true,
      labels: {
        queued: "agent:queued",
        running: "agent:running",
        failed: "agent:failed",
        needsUserReply: "agent:needs-user-reply"
      },
      webhookQueuePath: "queue.json",
      addLabel,
      removeLabel,
      enqueueWebhookIssue,
      removeRunningIssue,
      removeActivity,
      clearRetry,
      log
    });

    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(enqueueWebhookIssue).not.toHaveBeenCalled();
    expect(removeRunningIssue).not.toHaveBeenCalled();
    expect(removeActivity).not.toHaveBeenCalled();
    expect(clearRetry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Dry-run"), expect.any(Object));
  });

  it("cleans local state and re-queues without posting failure comments", async () => {
    const issue = createIssue();
    const addLabel = vi.fn(async () => {});
    const removeLabel = vi.fn(async () => {});
    const enqueueWebhookIssue = vi.fn(async () => true);
    const removeRunningIssue = vi.fn();
    const removeActivity = vi.fn();
    const clearRetry = vi.fn();
    const log = vi.fn();

    await recoverStalledIssue({
      issue,
      reason: "missing_state",
      dryRun: false,
      labels: {
        queued: "agent:queued",
        running: "agent:running",
        failed: "agent:failed",
        needsUserReply: "agent:needs-user-reply"
      },
      webhookQueuePath: "queue.json",
      addLabel,
      removeLabel,
      enqueueWebhookIssue,
      removeRunningIssue,
      removeActivity,
      clearRetry,
      log
    });

    expect(clearRetry).toHaveBeenCalledWith(issue.id);
    expect(removeRunningIssue).toHaveBeenCalledWith(issue.id);
    expect(removeActivity).toHaveBeenCalledWith(`issue:${issue.id}`);
    expect(addLabel).toHaveBeenCalledWith(issue, ["agent:queued"]);
    expect(removeLabel).toHaveBeenNthCalledWith(1, issue, "agent:running");
    expect(removeLabel).toHaveBeenNthCalledWith(2, issue, "agent:failed");
    expect(removeLabel).toHaveBeenNthCalledWith(3, issue, "agent:needs-user-reply");
    expect(enqueueWebhookIssue).toHaveBeenCalledWith("queue.json", issue);
    expect(log).toHaveBeenCalledWith("info", "Recovered stalled running issue and re-queued.", expect.any(Object));
  });
});

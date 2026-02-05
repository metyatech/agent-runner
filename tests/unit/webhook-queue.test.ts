import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueueWebhookIssue,
  loadWebhookQueue,
  removeWebhookIssues
} from "../../src/webhook-queue.js";
import type { IssueInfo } from "../../src/github.js";

describe("webhook-queue", () => {
  it("enqueues and removes issues", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-webhook-"));
    const queuePath = path.join(root, "state", "webhook-queue.json");
    const issue: IssueInfo = {
      id: 1,
      number: 42,
      title: "Test issue",
      body: null,
      author: "metyatech",
      repo: { owner: "metyatech", repo: "demo" },
      labels: [],
      url: "https://example.com/issues/42",
      isPullRequest: false
    };

    const first = await enqueueWebhookIssue(queuePath, issue);
    expect(first).toBe(true);
    const second = await enqueueWebhookIssue(queuePath, issue);
    expect(second).toBe(false);

    const queued = loadWebhookQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0].issueId).toBe(1);

    await removeWebhookIssues(queuePath, [1]);
    const cleared = loadWebhookQueue(queuePath);
    expect(cleared).toHaveLength(0);
  });
});

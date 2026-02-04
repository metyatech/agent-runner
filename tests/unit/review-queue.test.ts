import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "../../src/github.js";
import { enqueueReviewTask, loadReviewQueue, takeReviewTasks } from "../../src/review-queue.js";

describe("review-queue", () => {
  it("enqueues and dedupes by issueId", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-review-queue-"));
    const queuePath = path.join(root, "agent-runner", "state", "review-queue.json");
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const inserted1 = await enqueueReviewTask(queuePath, {
      issueId: 123,
      repo,
      prNumber: 5,
      url: "https://github.com/metyatech/demo/pull/5",
      reason: "review_comment",
      requiresEngine: true
    });
    const inserted2 = await enqueueReviewTask(queuePath, {
      issueId: 123,
      repo,
      prNumber: 5,
      url: "https://github.com/metyatech/demo/pull/5",
      reason: "review_comment",
      requiresEngine: true
    });
    expect(inserted1).toBe(true);
    expect(inserted2).toBe(false);
    expect(loadReviewQueue(queuePath)).toHaveLength(1);
  });

  it("takes tasks atomically", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-review-queue-"));
    const queuePath = path.join(root, "agent-runner", "state", "review-queue.json");
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    await enqueueReviewTask(queuePath, {
      issueId: 1,
      repo,
      prNumber: 1,
      url: "https://github.com/metyatech/demo/pull/1",
      reason: "review_comment",
      requiresEngine: true
    });
    await enqueueReviewTask(queuePath, {
      issueId: 2,
      repo,
      prNumber: 2,
      url: "https://github.com/metyatech/demo/pull/2",
      reason: "review_comment",
      requiresEngine: true
    });
    const taken = await takeReviewTasks(queuePath, 1);
    expect(taken).toHaveLength(1);
    expect(taken[0].issueId).toBe(1);
    expect(loadReviewQueue(queuePath)).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueReviewTask, loadReviewQueue, takeReviewTasksWhere } from "../../src/review-queue.js";

describe("review-queue (filter)", () => {
  it("takes entries matching predicate and preserves others", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-review-queue-filter-"));
    const queuePath = path.join(root, "agent-runner", "state", "review-queue.json");
    const repo = { owner: "metyatech", repo: "demo" };

    await enqueueReviewTask(queuePath, {
      issueId: 1,
      prNumber: 1,
      repo,
      url: "https://example.com/1",
      reason: "approval",
      requiresEngine: false
    });
    await enqueueReviewTask(queuePath, {
      issueId: 2,
      prNumber: 2,
      repo,
      url: "https://example.com/2",
      reason: "review",
      requiresEngine: true
    });
    await enqueueReviewTask(queuePath, {
      issueId: 3,
      prNumber: 3,
      repo,
      url: "https://example.com/3",
      reason: "approval",
      requiresEngine: false
    });

    const taken = await takeReviewTasksWhere(queuePath, 2, entry => !entry.requiresEngine);
    expect(taken.map(entry => entry.issueId)).toEqual([1, 3]);

    const remaining = loadReviewQueue(queuePath);
    expect(remaining.map(entry => entry.issueId)).toEqual([2]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

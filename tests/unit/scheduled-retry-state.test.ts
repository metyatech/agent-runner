import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRetry,
  resolveScheduledRetryStatePath,
  scheduleRetry,
  takeDueRetries
} from "../../src/scheduled-retry-state.js";

describe("scheduled-retry-state", () => {
  it("returns only due retries and keeps future retries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-scheduled-retry-"));
    const statePath = resolveScheduledRetryStatePath(root);
    const baseIssue = {
      title: "Issue",
      body: null,
      author: null,
      labels: [],
      url: "https://github.com/metyatech/demo/issues/1",
      isPullRequest: false,
      repo: { owner: "metyatech", repo: "demo" }
    };

    scheduleRetry(
      statePath,
      { ...baseIssue, id: 1, number: 1 },
      "2026-02-06T00:00:00.000Z",
      "session-a"
    );
    scheduleRetry(
      statePath,
      { ...baseIssue, id: 2, number: 2, url: "https://github.com/metyatech/demo/issues/2" },
      "2026-02-07T00:00:00.000Z",
      "session-b"
    );

    const due = takeDueRetries(statePath, new Date("2026-02-06T12:00:00.000Z"));
    expect(due).toHaveLength(1);
    expect(due[0]?.issueId).toBe(1);
    expect(due[0]?.sessionId).toBe("session-a");

    const none = takeDueRetries(statePath, new Date("2026-02-06T12:00:00.000Z"));
    expect(none).toHaveLength(0);

    const futureNowDue = takeDueRetries(statePath, new Date("2026-02-07T12:00:00.000Z"));
    expect(futureNowDue).toHaveLength(1);
    expect(futureNowDue[0]?.issueId).toBe(2);

    clearRetry(statePath, 2);
    expect(takeDueRetries(statePath, new Date("2026-02-08T00:00:00.000Z"))).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadActivityState,
  recordActivity,
  resolveActivityStatePath
} from "../../src/activity-state.js";
import { enqueueReviewTask, resolveReviewQueuePath } from "../../src/review-queue.js";
import { recordRunningIssue, resolveRunnerStatePath } from "../../src/runner-state.js";
import { buildStatusSnapshot } from "../../src/status-snapshot.js";

describe("status-snapshot", () => {
  it("prunes stale activity records from state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const statePath = resolveActivityStatePath(root);

    recordActivity(statePath, {
      id: "idle:stale",
      kind: "idle",
      repo: { owner: "metyatech", repo: "demo" },
      startedAt: new Date().toISOString(),
      pid: 0,
      logPath: path.join(root, "stale.log"),
      task: "demo"
    });

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.running).toHaveLength(0);
    expect(snapshot.stale).toHaveLength(0);

    const state = loadActivityState(statePath);
    expect(state.running).toHaveLength(0);
  });

  it("marks busy when activity record is alive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const statePath = resolveActivityStatePath(root);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore"
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (typeof child.pid !== "number") {
      throw new Error("Expected child process pid.");
    }
    const pid = child.pid;

    recordActivity(statePath, {
      id: "idle:test",
      kind: "idle",
      repo: { owner: "metyatech", repo: "demo" },
      startedAt: new Date().toISOString(),
      pid,
      logPath: path.join(root, "log.txt"),
      task: "demo"
    });

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.stopRequested).toBe(false);
    expect(snapshot.generatedAtLocal).toBeTruthy();
    expect(snapshot.running.length).toBe(1);

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  });

  it("includes issue records tracked by runner state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const runnerPath = resolveRunnerStatePath(root);
    recordRunningIssue(runnerPath, {
      issueId: 123,
      issueNumber: 7,
      repo: { owner: "metyatech", repo: "demo" },
      startedAt: new Date().toISOString(),
      pid: process.pid,
      logPath: path.join(root, "log.txt")
    });

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.stopRequested).toBe(false);
    expect(snapshot.generatedAtLocal).toBeTruthy();
    expect(snapshot.running.length).toBe(1);
    expect(snapshot.running[0].issueId).toBe(123);
  });

  it("includes review follow-up queue entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const queuePath = resolveReviewQueuePath(root);
    await enqueueReviewTask(queuePath, {
      issueId: 777,
      prNumber: 10,
      repo: { owner: "metyatech", repo: "programming-course-docs" },
      url: "https://github.com/metyatech/programming-course-docs/pull/10",
      reason: "approval",
      requiresEngine: true
    });

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.reviewFollowups).toHaveLength(1);
    expect(snapshot.reviewFollowups[0]?.issueId).toBe(777);
    expect(snapshot.reviewFollowups[0]?.waitMinutes).toBeGreaterThanOrEqual(0);
  });

  it("marks engine follow-ups as waiting when idle gates are blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const queuePath = resolveReviewQueuePath(root);
    await enqueueReviewTask(queuePath, {
      issueId: 888,
      prNumber: 11,
      repo: { owner: "metyatech", repo: "programming-course-docs" },
      url: "https://github.com/metyatech/programming-course-docs/pull/11",
      reason: "approval",
      requiresEngine: true
    });

    const logsDir = path.resolve(root, "agent-runner", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const taskLogPath = path.join(logsDir, "task-run-test.log");
    const now = new Date().toISOString();
    fs.writeFileSync(
      taskLogPath,
      `[${now}] [INFO] [review] Review follow-up backlog detected but all idle engine gates are blocked. Skipping engine-required review follow-ups. {"queued":1}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(logsDir, "latest-task-run.path"), `${taskLogPath}\n`, "utf8");

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.reviewIdleGateBlocked).toBe(true);
    expect(snapshot.reviewFollowups[0]?.status).toBe("waiting");
    expect(snapshot.reviewFollowups[0]?.nextAction).toContain("No action required");
  });

  it("marks follow-ups as queued when idle gates are not blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const queuePath = resolveReviewQueuePath(root);
    await enqueueReviewTask(queuePath, {
      issueId: 889,
      prNumber: 12,
      repo: { owner: "metyatech", repo: "programming-course-docs" },
      url: "https://github.com/metyatech/programming-course-docs/pull/12",
      reason: "approval",
      requiresEngine: true
    });

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.reviewIdleGateBlocked).toBe(false);
    expect(snapshot.reviewFollowups[0]?.status).toBe("queued");
    expect(snapshot.reviewFollowups[0]?.nextAction).toContain("automatically");
  });
});

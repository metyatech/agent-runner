import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  recordActivity,
  resolveActivityStatePath
} from "../../src/activity-state.js";
import { resolveRunnerStatePath } from "../../src/runner-state.js";
import { buildStatusSnapshot } from "../../src/status-snapshot.js";

describe("status-snapshot", () => {
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

  it("falls back to runner state when activity is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-status-"));
    const runnerPath = resolveRunnerStatePath(root);
    fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
    fs.writeFileSync(
      runnerPath,
      JSON.stringify(
        {
          running: [
            {
              issueId: 123,
              issueNumber: 7,
              repo: { owner: "metyatech", repo: "demo" },
              startedAt: new Date().toISOString(),
              pid: process.pid,
              logPath: path.join(root, "log.txt")
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const snapshot = buildStatusSnapshot(root);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.stopRequested).toBe(false);
    expect(snapshot.generatedAtLocal).toBeTruthy();
    expect(snapshot.running.length).toBe(1);
    expect(snapshot.running[0].issueId).toBe(123);
  });
});

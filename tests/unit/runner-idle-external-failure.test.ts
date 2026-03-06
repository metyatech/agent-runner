import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/git-worktree.js", () => ({
  ensureRepoCache: vi.fn(async () => "D:\\cache\\demo.git"),
  refreshRepoCache: vi.fn(async () => {
    throw new Error(
      "Command failed (128): git -C D:\\cache\\demo.git fetch --prune --tags origin\n" +
        "remote: Repository not found.\n" +
        "fatal: repository 'https://github.com/metyatech/demo.git/' not found"
    );
  }),
  createWorktreeFromDefaultBranch: vi.fn(),
  createWorktreeForRemoteBranch: vi.fn(),
  removeWorktree: vi.fn(),
  resolveRunWorkRoot: (workdirRoot: string, runId: string) =>
    path.join(workdirRoot, "agent-runner", "work", runId)
}));

describe("runIdleTask external repository failures", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("returns a failure result instead of throwing for missing remote repos", async () => {
    const { runIdleTask } = await import("../../src/runner.js");
    const workdirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-idle-missing-"));
    tempRoots.push(workdirRoot);

    const result = await runIdleTask(
      {
        workdirRoot,
        labels: {
          queued: "agent:queued",
          reviewFollowup: "agent:review-followup",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
        owner: "metyatech",
        repos: "all",
        pollIntervalSeconds: 60,
        concurrency: 1,
        idle: {
          enabled: true,
          maxRunsPerCycle: 1,
          cooldownMinutes: 60,
          tasks: ["noop"],
          promptTemplate: "Task {{task}} for {{repo}}"
        },
        codex: {
          command: "codex",
          args: ["exec", "--full-auto"],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      },
      { owner: "metyatech", repo: "demo" },
      "noop",
      "codex"
    );

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("execution_error");
    expect(result.failureDetail).toContain("Remote repository is unavailable");
    expect(fs.existsSync(result.logPath)).toBe(true);
    expect(fs.existsSync(result.reportPath)).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoInfo } from "../../src/github.js";

describe("git-worktree", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fetches PR head branch into refs/remotes/origin via explicit refspec", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-worktree-"));
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const worktreePath = path.join(root, "agent-runner", "work", "test-run", "metyatech--demo");
    const cachePath = path.join(root, "agent-runner", "git-cache", repo.owner, `${repo.repo}.git`);
    fs.mkdirSync(cachePath, { recursive: true });
    const runCommandMock = vi.fn(async (_command: string, args: string[]) => {
      const candidate = args.at(-1);
      const isShowRef =
        args.length >= 6 &&
        args[0] === "-C" &&
        args[2] === "show-ref" &&
        args[3] === "--verify" &&
        args[4] === "--quiet";
      if (isShowRef && candidate === "refs/remotes/origin/compliance-fix") {
        return { stdout: "", stderr: "" };
      }
      if (isShowRef) {
        throw new Error("ref not found");
      }
      return { stdout: "", stderr: "" };
    });
    vi.doMock("../../src/git.js", () => ({ runCommand: runCommandMock }));
    const { createWorktreeForRemoteBranch } = await import("../../src/git-worktree.js");

    try {
      await createWorktreeForRemoteBranch({
        workdirRoot: root,
        repo,
        cachePath,
        worktreePath,
        branch: "compliance-fix"
      });

      const fetchCall = runCommandMock.mock.calls.find(
        (call) => call[1][2] === "fetch" && call[1][3] === "--prune"
      );
      expect(fetchCall?.[1]).toEqual([
        "-C",
        cachePath,
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/compliance-fix:refs/remotes/origin/compliance-fix"
      ]);
      expect(runCommandMock).toHaveBeenCalledWith(
        "git",
        ["-C", cachePath, "show-ref", "--verify", "--quiet", "refs/remotes/origin/compliance-fix"],
        expect.objectContaining({ env: expect.any(Object) })
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock("../../src/git.js");
    }
  });

  it("removes stale conflicting worktree before forcing branch update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-worktree-"));
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const worktreePath = path.join(root, "agent-runner", "work", "issue-200-222", "metyatech--demo");
    const stalePath = path.join(root, "agent-runner", "work", "issue-100-111", "metyatech--demo");
    fs.mkdirSync(stalePath, { recursive: true });
    const cachePath = path.join(root, "agent-runner", "git-cache", repo.owner, `${repo.repo}.git`);
    fs.mkdirSync(cachePath, { recursive: true });
    const stalePathGit = stalePath.replace(/\\/g, "/");
    let removed = false;

    const runCommandMock = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "worktree" && args[3] === "list" && args[4] === "--porcelain") {
        const lines = [`worktree ${cachePath.replace(/\\/g, "/")}`, "bare", ""];
        if (!removed) {
          lines.push(
            `worktree ${stalePathGit}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/fix/compliance-gaps",
            ""
          );
        }
        return { stdout: lines.join("\n"), stderr: "" };
      }
      if (args[2] === "worktree" && args[3] === "remove" && args[5] === stalePathGit) {
        removed = true;
        return { stdout: "", stderr: "" };
      }
      const candidate = args.at(-1);
      const isShowRef =
        args.length >= 6 &&
        args[0] === "-C" &&
        args[2] === "show-ref" &&
        args[3] === "--verify" &&
        args[4] === "--quiet";
      if (isShowRef && candidate === "refs/remotes/origin/fix/compliance-gaps") {
        return { stdout: "", stderr: "" };
      }
      if (isShowRef) {
        throw new Error("ref not found");
      }
      return { stdout: "", stderr: "" };
    });
    vi.doMock("../../src/git.js", () => ({ runCommand: runCommandMock }));
    vi.doMock("../../src/runner-state.js", () => ({
      resolveRunnerStatePath: vi.fn(() => path.join(root, "state", "state.sqlite")),
      loadRunnerState: vi.fn(() => ({ running: [] })),
      isProcessAlive: vi.fn(() => false)
    }));

    const { createWorktreeForRemoteBranch } = await import("../../src/git-worktree.js");

    try {
      await createWorktreeForRemoteBranch({
        workdirRoot: root,
        repo,
        cachePath,
        worktreePath,
        branch: "fix/compliance-gaps"
      });

      const removeIndex = runCommandMock.mock.calls.findIndex(
        (call) => call[1][2] === "worktree" && call[1][3] === "remove" && call[1][5] === stalePathGit
      );
      const branchForceIndex = runCommandMock.mock.calls.findIndex(
        (call) => call[1][2] === "branch" && call[1][3] === "-f" && call[1][4] === "fix/compliance-gaps"
      );

      expect(removeIndex).toBeGreaterThanOrEqual(0);
      expect(branchForceIndex).toBeGreaterThanOrEqual(0);
      expect(removeIndex).toBeLessThan(branchForceIndex);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock("../../src/git.js");
      vi.doUnmock("../../src/runner-state.js");
    }
  });

  it("fails with an actionable error when the conflicting worktree is still active", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-worktree-"));
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const worktreePath = path.join(root, "agent-runner", "work", "issue-200-222", "metyatech--demo");
    const activePath = path.join(root, "agent-runner", "work", "issue-100-111", "metyatech--demo");
    fs.mkdirSync(activePath, { recursive: true });
    const cachePath = path.join(root, "agent-runner", "git-cache", repo.owner, `${repo.repo}.git`);
    fs.mkdirSync(cachePath, { recursive: true });
    const activePathGit = activePath.replace(/\\/g, "/");

    const runCommandMock = vi.fn(async (_command: string, args: string[]) => {
      if (args[2] === "worktree" && args[3] === "list" && args[4] === "--porcelain") {
        return {
          stdout: [
            `worktree ${cachePath.replace(/\\/g, "/")}`,
            "bare",
            "",
            `worktree ${activePathGit}`,
            "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "branch refs/heads/fix/compliance-gaps",
            ""
          ].join("\n"),
          stderr: ""
        };
      }
      return { stdout: "", stderr: "" };
    });
    vi.doMock("../../src/git.js", () => ({ runCommand: runCommandMock }));
    vi.doMock("../../src/runner-state.js", () => ({
      resolveRunnerStatePath: vi.fn(() => path.join(root, "state", "state.sqlite")),
      loadRunnerState: vi.fn(() => ({
        running: [
          {
            issueId: 100,
            issueNumber: 1,
            repo,
            startedAt: "2026-02-17T00:00:00.000Z",
            pid: 1234,
            logPath: "D:/ghws/agent-runner/logs/active.log"
          }
        ]
      })),
      isProcessAlive: vi.fn(() => true)
    }));
    const { createWorktreeForRemoteBranch } = await import("../../src/git-worktree.js");

    try {
      await expect(
        createWorktreeForRemoteBranch({
          workdirRoot: root,
          repo,
          cachePath,
          worktreePath,
          branch: "fix/compliance-gaps"
        })
      ).rejects.toThrow(`already checked out by an active worktree: ${activePathGit}`);

      expect(
        runCommandMock.mock.calls.some((call) => call[1][2] === "worktree" && call[1][3] === "remove")
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock("../../src/git.js");
      vi.doUnmock("../../src/runner-state.js");
    }
  });
});

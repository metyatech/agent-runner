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
        return "";
      }
      if (isShowRef) {
        throw new Error("ref not found");
      }
      return "";
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

      const fetchCall = runCommandMock.mock.calls.find(call => call[1][2] === "fetch" && call[1][3] === "--prune");
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
});

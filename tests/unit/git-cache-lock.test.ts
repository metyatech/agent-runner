import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  acquireGitCacheLock,
  releaseGitCacheLock,
  resolveGitCacheLockPath
} from "../../src/git-cache-lock.js";

describe("git-cache-lock", () => {
  it("creates lock path under workdir state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-cache-lock-"));
    const lockPath = resolveGitCacheLockPath(root, { owner: "metyatech", repo: "demo" });
    expect(lockPath).toContain(path.join("agent-runner", "state", "git-cache-locks"));
  });

  it("waits until lock is released", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-cache-lock-"));
    const repo = { owner: "metyatech", repo: "demo" };
    const first = await acquireGitCacheLock(root, repo, { timeoutMs: 2000, retryMs: 10 });
    try {
      const pending = acquireGitCacheLock(root, repo, { timeoutMs: 2000, retryMs: 10 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseGitCacheLock(first);
      const second = await pending;
      releaseGitCacheLock(second);
    } finally {
      try {
        releaseGitCacheLock(first);
      } catch {
        // ignore
      }
    }
  });
});

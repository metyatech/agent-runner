import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { acquireRepoLocks, resolveRepoLockPath, releaseRepoLock } from "../../src/repo-lock.js";

describe("repo-lock", () => {
  it("creates lock path under workdir state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-repo-lock-"));
    const lockPath = resolveRepoLockPath(root, { owner: "metyatech", repo: "demo" });
    expect(lockPath).toContain(path.join("agent-runner", "state", "repo-locks"));
  });

  it("acquires and releases locks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-repo-lock-"));
    const locks = acquireRepoLocks(root, [{ owner: "metyatech", repo: "demo" }]);
    expect(locks).toHaveLength(1);
    releaseRepoLock(locks[0]);
  });
});


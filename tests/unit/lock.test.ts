import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, tryAcquireLock } from "../../src/lock.js";

const stateDir = path.join(process.cwd(), "state-test");
const lockPath = path.join(stateDir, "runner.lock");

describe("lock", () => {
  it("acquires and releases", () => {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    const lock = acquireLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock(lock);
    expect(fs.existsSync(lockPath)).toBe(false);
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("lock conflict (regression: lock-conflict restart loop)", () => {
  let tmpDir: string;
  let conflictLockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-lock-test-"));
    conflictLockPath = path.join(tmpDir, "runner.lock");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquireLock throws 'Runner already active' when live process holds the lock", () => {
    // Acquire lock with the current process (it is alive).
    const lock = acquireLock(conflictLockPath);
    try {
      // A second acquireLock attempt on the same path must throw.
      expect(() => acquireLock(conflictLockPath)).toThrow(/Runner already active/);
    } finally {
      releaseLock(lock);
    }
  });

  it("tryAcquireLock returns null when live process holds the lock", () => {
    const lock = acquireLock(conflictLockPath);
    try {
      const result = tryAcquireLock(conflictLockPath);
      // Must not acquire — another live holder exists.
      expect(result).toBeNull();
    } finally {
      releaseLock(lock);
    }
  });

  it("acquireLock re-acquires a stale lock (dead-process pid)", () => {
    // Write a lock file whose pid cannot be alive (pid 0 is never a user process).
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      conflictLockPath,
      JSON.stringify({ pid: 0, startedAt: new Date().toISOString() })
    );
    const lock = acquireLock(conflictLockPath);
    expect(lock).toBeDefined();
    releaseLock(lock);
  });
});

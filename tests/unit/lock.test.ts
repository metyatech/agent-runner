import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/lock.js";

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

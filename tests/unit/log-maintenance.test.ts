import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { pruneLogs, type LogMaintenanceDecision } from "../../src/log-maintenance.js";

function touch(filePath: string, mtime: Date): void {
  fs.writeFileSync(filePath, "x", "utf8");
  fs.utimesSync(filePath, mtime, mtime);
}

describe("pruneLogs", () => {
  it("prunes task-run logs beyond taskRunKeepLatest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-logs-"));
    const base = new Date("2026-02-03T00:00:00.000Z");

    for (let i = 0; i < 5; i += 1) {
      touch(path.join(dir, `task-run-20260203-00000${i}.log`), new Date(base.getTime() + i * 1000));
    }
    touch(path.join(dir, "repo-issue-1-0.log"), new Date(base.getTime() + 9999));

    const decision: LogMaintenanceDecision = {
      enabled: true,
      maxAgeDays: 0,
      keepLatest: 1000,
      maxTotalBytes: null,
      taskRunKeepLatest: 2,
      writeLatestPointers: true
    };

    const result = pruneLogs({
      dir,
      decision,
      dryRun: true,
      now: new Date(base.getTime() + 20000)
    });
    expect(result.deleted).toBe(3);
    expect(result.kept).toBe(3);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prunes by maxAgeDays beyond keepLatest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-logs-"));
    const now = new Date("2026-02-03T12:00:00.000Z");
    const old = new Date("2026-01-01T00:00:00.000Z");

    touch(path.join(dir, "recent.log"), new Date(now.getTime() - 60 * 1000));
    touch(path.join(dir, "old1.log"), old);
    touch(path.join(dir, "old2.log"), old);

    const decision: LogMaintenanceDecision = {
      enabled: true,
      maxAgeDays: 7,
      keepLatest: 1,
      maxTotalBytes: null,
      taskRunKeepLatest: 1000,
      writeLatestPointers: true
    };

    const result = pruneLogs({ dir, decision, dryRun: true, now });
    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

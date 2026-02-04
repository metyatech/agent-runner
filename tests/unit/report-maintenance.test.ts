import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { pruneReports, type ReportMaintenanceDecision } from "../../src/report-maintenance.js";

function touch(filePath: string, mtime: Date): void {
  fs.writeFileSync(filePath, "x", "utf8");
  fs.utimesSync(filePath, mtime, mtime);
}

describe("pruneReports", () => {
  it("prunes by maxAgeDays beyond keepLatest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-reports-"));
    const now = new Date("2026-02-03T12:00:00.000Z");
    const old = new Date("2026-01-01T00:00:00.000Z");

    touch(path.join(dir, "recent.md"), new Date(now.getTime() - 60 * 1000));
    touch(path.join(dir, "old1.md"), old);
    touch(path.join(dir, "old2.md"), old);

    const decision: ReportMaintenanceDecision = {
      enabled: true,
      maxAgeDays: 7,
      keepLatest: 1,
      maxTotalBytes: null
    };

    const result = pruneReports({ dir, decision, dryRun: true, now });
    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores non-markdown files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-reports-"));
    const now = new Date("2026-02-03T12:00:00.000Z");
    const old = new Date("2026-01-01T00:00:00.000Z");

    touch(path.join(dir, "old.txt"), old);
    touch(path.join(dir, "old.md"), old);

    const decision: ReportMaintenanceDecision = {
      enabled: true,
      maxAgeDays: 7,
      keepLatest: 0,
      maxTotalBytes: null
    };

    const result = pruneReports({ dir, decision, dryRun: true, now });
    expect(result.deleted).toBe(1);
    expect(result.scanned).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});


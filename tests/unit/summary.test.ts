import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSummaryFromLog } from "../../src/runner.js";

describe("extractSummaryFromLog", () => {
  it("parses summary between markers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-summary-"));
    const logPath = path.join(tempDir, "log.txt");
    const content = [
      "line1",
      "AGENT_RUNNER_SUMMARY_START",
      "- Change A",
      "Tests: npm run test",
      "Commits: abc1234",
      "AGENT_RUNNER_SUMMARY_END",
      "line2"
    ].join("\n");
    fs.writeFileSync(logPath, content, "utf8");

    const summary = extractSummaryFromLog(logPath);
    expect(summary).toBe("- Change A\nTests: npm run test\nCommits: abc1234");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when markers are missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-summary-"));
    const logPath = path.join(tempDir, "log.txt");
    fs.writeFileSync(logPath, "no markers", "utf8");

    const summary = extractSummaryFromLog(logPath);
    expect(summary).toBeNull();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

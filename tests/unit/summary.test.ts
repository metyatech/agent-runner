import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFinalResponseFromLog, parseAgentRunResult } from "../../src/runner.js";

describe("extractFinalResponseFromLog", () => {
  it("parses the final codex response block before token stats", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-summary-"));
    const logPath = path.join(tempDir, "log.txt");
    const content = [
      "header",
      "codex",
      "old response",
      "tokens used",
      "123",
      "codex",
      "AGENT_RUNNER_STATUS: done",
      "- Change A",
      "Tests: npm run test",
      "Commits: abc1234",
      "tokens used",
      "456"
    ].join("\n");
    fs.writeFileSync(logPath, content, "utf8");

    const summary = extractFinalResponseFromLog(logPath);
    expect(summary).toBe(
      "AGENT_RUNNER_STATUS: done\n- Change A\nTests: npm run test\nCommits: abc1234"
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when codex response marker is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-summary-"));
    const logPath = path.join(tempDir, "log.txt");
    fs.writeFileSync(logPath, "no codex block", "utf8");

    const summary = extractFinalResponseFromLog(logPath);
    expect(summary).toBeNull();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("parseAgentRunResult", () => {
  it("parses done status and strips status line from response", () => {
    const parsed = parseAgentRunResult("AGENT_RUNNER_STATUS: done\nWork completed.");
    expect(parsed.status).toBe("done");
    expect(parsed.response).toBe("Work completed.");
  });

  it("parses needs_user_reply status and strips status line from response", () => {
    const parsed = parseAgentRunResult(
      "AGENT_RUNNER_STATUS: needs_user_reply\nPlease answer question A."
    );
    expect(parsed.status).toBe("needs_user_reply");
    expect(parsed.response).toBe("Please answer question A.");
  });

  it("parses status line even when explanatory text appears before it", () => {
    const parsed = parseAgentRunResult(
      [
        "I verified the current state and prepared a plan.",
        "AGENT_RUNNER_STATUS: needs_user_reply",
        "Please confirm whether I should proceed with this plan."
      ].join("\n")
    );
    expect(parsed.status).toBe("needs_user_reply");
    expect(parsed.response).toBe(
      "I verified the current state and prepared a plan.\nPlease confirm whether I should proceed with this plan."
    );
  });

  it("treats response without status line as plain response", () => {
    const parsed = parseAgentRunResult("Plain final response");
    expect(parsed.status).toBeNull();
    expect(parsed.response).toBe("Plain final response");
  });
});

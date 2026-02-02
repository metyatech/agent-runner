import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIdleReportState, resolveIdleReportStatePath, saveIdleReportState } from "../../src/idle-report.js";

describe("idle report state", () => {
  it("returns null when state file is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-idle-report-"));
    const statePath = resolveIdleReportStatePath(tempDir);

    expect(loadIdleReportState(statePath)).toBeNull();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-idle-report-"));
    const statePath = resolveIdleReportStatePath(tempDir);
    const state = {
      repo: "metyatech/agent-runner",
      issueId: 4242,
      issueNumber: 42,
      issueUrl: "https://github.com/metyatech/agent-runner/issues/42"
    };

    saveIdleReportState(statePath, state);

    expect(loadIdleReportState(statePath)).toEqual(state);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

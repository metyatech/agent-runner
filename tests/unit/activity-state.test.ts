import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadActivityState,
  recordActivity,
  removeActivity,
  resolveActivityStatePath
} from "../../src/activity-state.js";

describe("activity-state", () => {
  it("records and removes activity entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-activity-"));
    const statePath = resolveActivityStatePath(root);
    const record = {
      id: "issue:1",
      kind: "issue" as const,
      repo: { owner: "metyatech", repo: "demo" },
      startedAt: new Date().toISOString(),
      pid: 1234,
      logPath: path.join(root, "log.txt"),
      issueId: 1,
      issueNumber: 1
    };

    recordActivity(statePath, record);
    const loaded = loadActivityState(statePath);
    expect(loaded.running).toHaveLength(1);
    expect(loaded.running[0].id).toBe("issue:1");

    removeActivity(statePath, "issue:1");
    const cleared = loadActivityState(statePath);
    expect(cleared.running).toHaveLength(0);
  });
});

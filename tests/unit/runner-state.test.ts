import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IssueInfo } from "../../src/github.js";
import {
  evaluateRunningIssues,
  loadRunnerState,
  recordRunningIssue,
  removeRunningIssue,
  resolveRunnerStatePath
} from "../../src/runner-state.js";

function createIssue(id: number): IssueInfo {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: null,
    author: "metyatech",
    repo: { owner: "metyatech", repo: "repo" },
    labels: [],
    url: `https://example.com/${id}`,
    isPullRequest: false
  };
}

describe("runner-state", () => {
  it("records and removes running issues", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-state-"));
    const statePath = resolveRunnerStatePath(tempRoot);
    const issue = createIssue(1);

    recordRunningIssue(statePath, {
      issueId: issue.id,
      issueNumber: issue.number,
      repo: issue.repo,
      startedAt: "2026-01-30T00:00:00Z",
      pid: 123,
      logPath: "log"
    });

    const loaded = loadRunnerState(statePath);
    expect(loaded.running).toHaveLength(1);

    removeRunningIssue(statePath, issue.id);
    const cleared = loadRunnerState(statePath);
    expect(cleared.running).toHaveLength(0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("detects missing records and dead processes", () => {
    const issueA = createIssue(1);
    const issueB = createIssue(2);
    const state = {
      running: [
        {
          issueId: issueA.id,
          issueNumber: issueA.number,
          repo: issueA.repo,
          startedAt: "2026-01-30T00:00:00Z",
          pid: 999,
          logPath: "log"
        }
      ]
    };

    const result = evaluateRunningIssues([issueA, issueB], state, (pid) => pid === 123);
    expect(result.deadProcess.map((entry) => entry.issue.id)).toEqual([issueA.id]);
    expect(result.missingRecord.map((entry) => entry.id)).toEqual([issueB.id]);
  });
});

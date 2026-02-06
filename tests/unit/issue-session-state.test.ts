import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearIssueSession,
  getIssueSession,
  resolveIssueSessionStatePath,
  setIssueSession
} from "../../src/issue-session-state.js";

describe("issue-session-state", () => {
  it("stores, updates, and clears issue session ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-issue-session-"));
    const statePath = resolveIssueSessionStatePath(root);
    const issue = {
      id: 101,
      number: 5,
      title: "Issue",
      body: null,
      author: null,
      repo: { owner: "metyatech", repo: "demo" },
      labels: [],
      url: "https://github.com/metyatech/demo/issues/5",
      isPullRequest: false
    };

    expect(getIssueSession(statePath, issue)).toBeNull();

    setIssueSession(statePath, issue, "session-1");
    expect(getIssueSession(statePath, issue)).toBe("session-1");

    setIssueSession(statePath, issue, "session-2");
    expect(getIssueSession(statePath, issue)).toBe("session-2");

    clearIssueSession(statePath, issue.id);
    expect(getIssueSession(statePath, issue)).toBeNull();
  });
});

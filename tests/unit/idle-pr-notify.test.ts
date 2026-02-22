import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { notifyIdlePullRequest } from "../../src/idle-pr-notify.js";

const tempLogDirs: string[] = [];

function createTempLog(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-"));
  tempLogDirs.push(dir);
  const logPath = path.join(dir, "idle.log");
  fs.writeFileSync(logPath, contents, "utf8");
  return logPath;
}

describe("notifyIdlePullRequest", () => {
  afterAll(() => {
    for (const dir of tempLogDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempLogDirs.length = 0;
  });

  it("assigns the authenticated user and posts a comment (summary URL)", async () => {
    const calls: any = { addAssignees: [], commentIssue: [] };
    const client: any = {
      getAuthenticatedLogin: async () => "alice",
      getIssue: async () => null,
      addAssignees: async (repo: any, issueNumber: number, assignees: string[]) => {
        calls.addAssignees.push({ repo, issueNumber, assignees });
      },
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.commentIssue.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => null
    };

    const logPath = createTempLog("nothing");
    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: "Done https://github.com/metyatech/demo/pull/123",
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient: null,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: () => {}
    });

    expect(notified?.number).toBe(123);
    expect(calls.addAssignees).toHaveLength(1);
    expect(calls.addAssignees[0]).toMatchObject({ issueNumber: 123, assignees: ["alice"] });
    expect(calls.commentIssue).toHaveLength(1);
    expect(calls.commentIssue[0].body).toContain("@alice");
  });

  it("extracts PR URL from log tail when summary is missing", async () => {
    const calls: any = { commentIssue: [] };
    const client: any = {
      getAuthenticatedLogin: async () => null,
      getIssue: async () => null,
      addAssignees: async () => {},
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.commentIssue.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => null
    };

    const logPath = createTempLog("Created https://github.com/metyatech/demo/pull/9\n");
    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: null,
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient: null,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: () => {}
    });

    expect(notified?.number).toBe(9);
    expect(calls.commentIssue).toHaveLength(1);
  });

  it("falls back to posting a comment with client when notifyClient fails", async () => {
    const calls: any = { clientComments: [], notifyComments: [], logs: [] };
    const client: any = {
      getAuthenticatedLogin: async () => "alice",
      getIssue: async () => null,
      addAssignees: async () => {},
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.clientComments.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => null
    };

    const notifyClient: any = {
      commentIssue: async () => {
        calls.notifyComments.push({ called: true });
        throw new Error("notify down");
      }
    };

    const logPath = createTempLog("nothing");
    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: "Done https://github.com/metyatech/demo/pull/456",
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: (level, message, json, meta) => {
        calls.logs.push({ level, message, json, meta });
      }
    });

    expect(notified?.number).toBe(456);
    expect(calls.notifyComments).toHaveLength(1);
    expect(calls.clientComments).toHaveLength(1);
    expect(calls.clientComments[0].issueNumber).toBe(456);
    expect(calls.logs.some((entry: any) => entry.level === "warn")).toBe(true);
  });

  it("falls back to searching by head branch when no URL is available", async () => {
    const calls: any = { commentIssue: [] };
    const client: any = {
      getAuthenticatedLogin: async () => null,
      getIssue: async () => null,
      addAssignees: async () => {},
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.commentIssue.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => ({
        number: 42,
        url: "https://github.com/metyatech/demo/pull/42"
      })
    };

    const logPath = path.join(os.tmpdir(), "agent-runner-missing.log");
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore
    }

    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: null,
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient: null,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: () => {}
    });

    expect(notified?.number).toBe(42);
    expect(calls.commentIssue).toHaveLength(1);
  });

  it("treats head branch lookup failures as best-effort (no throw)", async () => {
    const calls: any = { commentIssue: [], addAssignees: [], logs: [] };
    const client: any = {
      getAuthenticatedLogin: async () => "alice",
      getIssue: async () => null,
      addAssignees: async (repo: any, issueNumber: number, assignees: string[]) => {
        calls.addAssignees.push({ repo, issueNumber, assignees });
      },
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.commentIssue.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => {
        throw new Error("boom");
      }
    };

    const logPath = path.join(os.tmpdir(), "agent-runner-missing.log");
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore
    }

    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: null,
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient: null,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: (level, message, json, meta) => {
        calls.logs.push({ level, message, json, meta });
      }
    });

    expect(notified).toBeNull();
    expect(calls.commentIssue).toHaveLength(0);
    expect(calls.addAssignees).toHaveLength(0);
    expect(calls.logs.some((entry: any) => entry.level === "warn")).toBe(true);
  });

  it("ignores PR URLs for a different repo and falls back to head branch", async () => {
    const calls: any = { addAssignees: [], commentIssue: [] };
    const client: any = {
      getAuthenticatedLogin: async () => "alice",
      getIssue: async () => null,
      addAssignees: async (repo: any, issueNumber: number, assignees: string[]) => {
        calls.addAssignees.push({ repo, issueNumber, assignees });
      },
      commentIssue: async (repo: any, issueNumber: number, body: string) => {
        calls.commentIssue.push({ repo, issueNumber, body });
      },
      findOpenPullRequestByHead: async () => ({
        number: 77,
        url: "https://github.com/metyatech/demo/pull/77"
      })
    };

    const logPath = createTempLog("no pr url here");
    const result: any = {
      success: true,
      logPath,
      repo: { owner: "metyatech", repo: "demo" },
      task: "T",
      engine: "codex",
      summary: "unrelated https://github.com/other/repo/pull/999",
      reportPath: "report.json",
      headBranch: "agent-runner/idle-codex-123"
    };

    const notified = await notifyIdlePullRequest({
      client,
      notifyClient: null,
      config: { workdirRoot: "D:/tmp" } as any,
      result,
      json: false,
      log: () => {}
    });

    expect(notified?.number).toBe(77);
    expect(calls.addAssignees).toHaveLength(1);
    expect(calls.addAssignees[0].issueNumber).toBe(77);
    expect(calls.commentIssue).toHaveLength(1);
    expect(calls.commentIssue[0].issueNumber).toBe(77);
  });
});

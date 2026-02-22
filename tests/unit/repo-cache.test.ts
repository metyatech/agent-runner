import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBlocked, isCacheFresh, loadRepoCache, saveRepoCache } from "../../src/repo-cache.js";
import { listTargetRepos } from "../../src/queue.js";

describe("repo-cache", () => {
  it("saves and loads repo cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-cache-"));
    const cache = {
      updatedAt: new Date().toISOString(),
      repos: [{ owner: "metyatech", repo: "demo" }],
      blockedUntil: null
    };
    saveRepoCache(root, cache);
    const loaded = loadRepoCache(root);
    expect(loaded?.repos).toHaveLength(1);
    expect(loaded?.repos[0].repo).toBe("demo");
  });

  it("detects cache freshness and block window", () => {
    const fresh = {
      updatedAt: new Date().toISOString(),
      repos: [],
      blockedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    expect(isCacheFresh(fresh, 10)).toBe(true);
    expect(isBlocked(fresh)).toBe(true);
  });

  it("falls back to local repos on rate limit when cache is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-cache-"));
    const repoDir = path.join(root, "demo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    const client = {
      listRepos: async () => {
        const error = new Error("API rate limit exceeded");
        (error as { status?: number }).status = 403;
        (error as { response?: { headers?: Record<string, string> } }).response = {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": Math.floor(Date.now() / 1000 + 60).toString()
          }
        };
        throw error;
      }
    };

    const result = await listTargetRepos(
      client as unknown as import("../../src/github.js").GitHubClient,
      {
        owner: "metyatech",
        repos: "all",
        workdirRoot: root,
        pollIntervalSeconds: 60,
        concurrency: 1,
        labels: {
          queued: "agent:queued",
          reviewFollowup: "agent:review-followup",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
        codex: {
          command: "codex",
          args: [],
          promptTemplate: ""
        }
      } as import("../../src/config.js").AgentRunnerConfig,
      root,
      60
    );

    expect(result.source).toBe("local");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].repo).toBe("demo");
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isBlocked,
  isCacheFresh,
  loadRepoCache,
  saveRepoCache
} from "../../src/repo-cache.js";

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
});

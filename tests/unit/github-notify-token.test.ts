import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGitHubNotifyToken } from "../../src/github-notify-token.js";

describe("github-notify-token", () => {
  it("prefers AGENT_GITHUB_NOTIFY_TOKEN over file", () => {
    const prior = process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-token-"));
      const stateDir = path.join(root, "agent-runner", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "github-notify-token.txt"), "from-file\n", "utf8");

      process.env.AGENT_GITHUB_NOTIFY_TOKEN = "from-env";
      expect(resolveGitHubNotifyToken(root)).toBe("from-env");
    } finally {
      if (typeof prior === "string") process.env.AGENT_GITHUB_NOTIFY_TOKEN = prior;
      else delete process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    }
  });

  it("reads token from state file when env is missing", () => {
    const prior = process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    try {
      delete process.env.AGENT_GITHUB_NOTIFY_TOKEN;

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-token-"));
      const stateDir = path.join(root, "agent-runner", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "github-notify-token.txt"), "  abc123  \n", "utf8");

      expect(resolveGitHubNotifyToken(root)).toBe("abc123");
    } finally {
      if (typeof prior === "string") process.env.AGENT_GITHUB_NOTIFY_TOKEN = prior;
      else delete process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    }
  });

  it("returns null when env and file are missing", () => {
    const prior = process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    try {
      delete process.env.AGENT_GITHUB_NOTIFY_TOKEN;

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-token-"));
      expect(resolveGitHubNotifyToken(root)).toBe(null);
    } finally {
      if (typeof prior === "string") process.env.AGENT_GITHUB_NOTIFY_TOKEN = prior;
      else delete process.env.AGENT_GITHUB_NOTIFY_TOKEN;
    }
  });
});

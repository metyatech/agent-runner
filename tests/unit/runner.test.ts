import { describe, expect, it } from "vitest";
import {
  buildAmazonQInvocation,
  buildCodexInvocation,
  buildCodexResumeInvocation,
  buildGeminiInvocation,
  buildIssueTaskText
} from "../../src/runner.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentComment, NEEDS_USER_MARKER } from "../../src/notifications.js";
import type { IssueComment, IssueInfo } from "../../src/github.js";

describe("buildCodexInvocation", () => {
  it("builds args without shell splitting", () => {
    const invocation = buildCodexInvocation(
      {
        workdirRoot: "D:\\ghws",
        labels: {
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
        owner: "metyatech",
        repos: "all",
        pollIntervalSeconds: 60,
        concurrency: 1,
        codex: {
          command: "codex",
          args: ["exec", "--full-auto"],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      },
      "D:\\ghws\\windows-openssh-server-startup",
      "You are running an autonomous task."
    );

    expect(invocation.args.at(-1)).toBe("You are running an autonomous task.");
    expect(invocation.options.shell).toBe(false);
  });

  it("builds resume invocation with exec options", () => {
    const invocation = buildCodexResumeInvocation(
      {
        workdirRoot: "D:\\ghws",
        labels: {
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user-reply"
        },
        owner: "metyatech",
        repos: "all",
        pollIntervalSeconds: 60,
        concurrency: 1,
        codex: {
          command: "codex",
          args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.2"],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      },
      "D:\\ghws\\repo",
      "019c30f6-2bc4-7923-9d61-131e96ed35a9",
      "Continue"
    );

    expect(invocation.args).toContain("resume");
    expect(invocation.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(invocation.args.at(-2)).toBe("019c30f6-2bc4-7923-9d61-131e96ed35a9");
    expect(invocation.args.at(-1)).toBe("Continue");
  });

  it("resolves cmd shim on Windows when available", () => {
    const originalPath = process.env.PATH;
    const originalAppData = process.env.APPDATA;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-codex-"));
    const shimPath = path.join(tempDir, "codex.cmd");
    const codexJs = path.join(tempDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(codexJs), { recursive: true });
    fs.writeFileSync(shimPath, "echo codex");
    fs.writeFileSync(codexJs, "console.log('codex');");
    process.env.PATH = tempDir;

    try {
      const invocation = buildCodexInvocation(
        {
          workdirRoot: "D:\\ghws",
        labels: {
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
          owner: "metyatech",
          repos: "all",
          pollIntervalSeconds: 60,
          concurrency: 1,
          codex: {
            command: "codex",
            args: ["exec", "--full-auto"],
            promptTemplate: "Template {{repos}} {{task}}"
          }
        },
        "D:\\ghws\\windows-openssh-server-startup",
        "Prompt"
      );

      expect(invocation.command.toLowerCase()).toContain("node");
      expect(invocation.args[0].toLowerCase()).toContain("codex.js");
    } finally {
      process.env.PATH = originalPath;
      process.env.APPDATA = originalAppData;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves cmd shim from APPDATA when PATH is missing", () => {
    const originalPath = process.env.PATH;
    const originalAppData = process.env.APPDATA;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-appdata-"));
    const npmDir = path.join(tempDir, "npm");
    const shimPath = path.join(npmDir, "codex.cmd");
    const codexJs = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(codexJs), { recursive: true });
    fs.writeFileSync(shimPath, "echo codex");
    fs.writeFileSync(codexJs, "console.log('codex');");
    process.env.PATH = "";
    process.env.APPDATA = tempDir;

    try {
      const invocation = buildCodexInvocation(
        {
          workdirRoot: "D:\\ghws",
          labels: {
            queued: "agent:queued",
            running: "agent:running",
            done: "agent:done",
            failed: "agent:failed",
            needsUserReply: "agent:needs-user"
          },
          owner: "metyatech",
          repos: "all",
          pollIntervalSeconds: 60,
          concurrency: 1,
          codex: {
            command: "codex",
            args: ["exec", "--full-auto"],
            promptTemplate: "Template {{repos}} {{task}}"
          }
        },
        "D:\\ghws\\windows-openssh-server-startup",
        "Prompt"
      );

      expect(invocation.command.toLowerCase()).toContain("node");
      expect(invocation.args[0].toLowerCase()).toContain("codex.js");
    } finally {
      process.env.PATH = originalPath;
      process.env.APPDATA = originalAppData;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildAmazonQInvocation", () => {
  it("passes prompt via stdin by default", () => {
    const invocation = buildAmazonQInvocation(
      {
        workdirRoot: "D:\\ghws",
        labels: {
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
        owner: "metyatech",
        repos: "all",
        pollIntervalSeconds: 60,
        concurrency: 1,
        logMaintenance: { enabled: true },
        amazonQ: {
          enabled: true,
          command: "kiro",
          args: ["chat"],
          promptMode: "stdin"
        },
        codex: {
          command: "codex",
          args: ["exec", "--full-auto"],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      },
      "D:\\ghws\\repo",
      "Prompt for Q"
    );

    expect(invocation.args.at(-1)).toBe("chat");
    expect(invocation.stdin).toBe("Prompt for Q");
  });

  it("passes prompt as last arg when promptMode=arg", () => {
    const invocation = buildAmazonQInvocation(
      {
        workdirRoot: "D:\\ghws",
        labels: {
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUserReply: "agent:needs-user"
        },
        owner: "metyatech",
        repos: "all",
        pollIntervalSeconds: 60,
        concurrency: 1,
        logMaintenance: { enabled: true },
        amazonQ: {
          enabled: true,
          command: "kiro",
          args: ["chat"],
          promptMode: "arg"
        },
        codex: {
          command: "codex",
          args: ["exec", "--full-auto"],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      },
      "D:\\ghws\\repo",
      "Prompt for Q"
    );

    expect(invocation.args.at(-1)).toBe("Prompt for Q");
    expect(invocation.stdin).toBeUndefined();
  });
});

describe("buildGeminiInvocation", () => {
  it("sets GEMINI_CLI_SYSTEM_DEFAULTS_PATH to disable interactive shell", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-gemini-"));

    try {
      const invocation = buildGeminiInvocation(
        {
          workdirRoot: tempDir,
          labels: {
            queued: "agent:queued",
            running: "agent:running",
            done: "agent:done",
            failed: "agent:failed",
            needsUserReply: "agent:needs-user"
          },
          owner: "metyatech",
          repos: "all",
          pollIntervalSeconds: 60,
          concurrency: 1,
          codex: {
            command: "codex",
            args: ["exec", "--full-auto"],
            promptTemplate: "Template {{repos}} {{task}}"
          },
          gemini: {
            command: "gemini",
            args: ["--approval-mode", "yolo", "-p"]
          }
        },
        path.join(tempDir, "repo"),
        "Prompt",
        "gemini-flash"
      );

      const defaultsPath = invocation.options.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
      if (!defaultsPath) {
        throw new Error("Expected GEMINI_CLI_SYSTEM_DEFAULTS_PATH to be set.");
      }
      expect(defaultsPath).toBe(path.join(tempDir, "agent-runner", "state", "gemini-system-defaults.json"));
      expect(fs.existsSync(defaultsPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(defaultsPath, "utf8")) as any;
      expect(parsed?.tools?.shell?.enableInteractiveShell).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildIssueTaskText", () => {
  const baseIssue: IssueInfo = {
    id: 1,
    number: 123,
    title: "Test issue",
    body: "Hello from issue body.",
    author: "metyatech",
    repo: { owner: "metyatech", repo: "agent-runner" },
    labels: [],
    url: "https://github.com/metyatech/agent-runner/issues/123",
    isPullRequest: false
  };

  it("includes issue title/body and omits agent-runner comments", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        body: buildAgentComment("failed", [NEEDS_USER_MARKER]),
        createdAt: "2026-01-30T10:00:00Z",
        author: "agent-runner-bot"
      },
      {
        id: 2,
        body: "I'll fix the env.",
        createdAt: "2026-01-30T10:05:00Z",
        author: "metyatech"
      }
    ];

    const text = buildIssueTaskText(baseIssue, comments);

    expect(text).toContain("Issue: Test issue");
    expect(text).toContain("Hello from issue body.");
    expect(text).toContain("I'll fix the env.");
    expect(text).not.toContain("failed");
    expect(text).toContain("Note: only user comments after the last needs-user marker");
  });

  it("ignores user comments before the last needs-user marker", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        body: "Earlier note.",
        createdAt: "2026-01-30T09:55:00Z",
        author: "metyatech"
      },
      {
        id: 2,
        body: buildAgentComment("failed", [NEEDS_USER_MARKER]),
        createdAt: "2026-01-30T10:00:00Z",
        author: "agent-runner-bot"
      },
      {
        id: 3,
        body: "New details after failure.",
        createdAt: "2026-01-30T10:05:00Z",
        author: "metyatech"
      }
    ];

    const text = buildIssueTaskText(baseIssue, comments);

    expect(text).toContain("New details after failure.");
    expect(text).not.toContain("Earlier note.");
  });

  it("truncates very large user comments", () => {
    const longBody = "a".repeat(10_000);
    const comments: IssueComment[] = [
      {
        id: 1,
        body: longBody,
        createdAt: "2026-01-30T10:05:00Z",
        author: "metyatech"
      }
    ];

    const text = buildIssueTaskText(baseIssue, comments);
    expect(text).toContain("…[truncated]");
  });
});


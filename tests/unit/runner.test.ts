import { describe, expect, it } from "vitest";
import {
  buildAmazonQInvocation,
  buildCodexInvocation,
  buildCodexResumeInvocation,
  buildGeminiInvocation,
  buildIssueTaskText,
  loadIdleOpenPrData,
  renderIdlePrompt
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

describe("renderIdlePrompt", () => {
  const repo = { owner: "metyatech", repo: "demo" };

  it("replaces open PR placeholders and always adds duplicate-work guard", () => {
    const prompt = renderIdlePrompt(
      "Repo {{repo}}\nTask {{task}}\nOpen PRs ({{openPrCount}})\n{{openPrContext}}",
      repo,
      "Improve retries",
      {
        openPrCount: 2,
        openPrContext: "- #10 Existing PR",
        openPrContextAvailable: true
      }
    );

    expect(prompt).toContain("Repo metyatech/demo");
    expect(prompt).toContain("Task Improve retries");
    expect(prompt).toContain("Open PRs (2)");
    expect(prompt).toContain("- #10 Existing PR");
    expect(prompt).toContain("Duplicate-work guard");
  });

  it("appends open PR context when placeholders are missing", () => {
    const prompt = renderIdlePrompt("Repo {{repo}}\nTask {{task}}", repo, "Improve retries", {
      openPrCount: 1,
      openPrContext: "- #22 Another PR",
      openPrContextAvailable: true
    });

    expect(prompt).toContain("Repo metyatech/demo");
    expect(prompt).toContain("Task Improve retries");
    expect(prompt).toContain("Open PR context:");
    expect(prompt).toContain("- #22 Another PR");
  });

  it("renders unknown open PR count when context lookup fails", () => {
    const prompt = renderIdlePrompt("Repo {{repo}}\nOpen PRs {{openPrCount}}", repo, "Improve retries", {
      openPrCount: null,
      openPrContext: "Open PR context unavailable due to GitHub API error.",
      openPrContextAvailable: false
    });

    expect(prompt).toContain("Open PRs unknown");
    expect(prompt).toContain("count in this repository: unknown");
    expect(prompt).toContain("Open PR context could not be fetched");
  });

  it("does not rewrite placeholder-like tokens embedded in open PR context", () => {
    const prompt = renderIdlePrompt("Task {{task}}\n{{openPrContext}}", repo, "Improve retries", {
      openPrCount: 1,
      openPrContext: "- #101 Literal token {{task}} from PR body",
      openPrContextAvailable: true
    });

    expect(prompt).toContain("- #101 Literal token {{task}} from PR body");
    expect(prompt).not.toContain("- #101 Literal token Improve retries from PR body");
  });

  it("wraps open PR context with explicit untrusted-data markers", () => {
    const prompt = renderIdlePrompt("{{openPrContext}}", repo, "Improve retries", {
      openPrCount: 1,
      openPrContext: "- #22 Another PR",
      openPrContextAvailable: true
    });

    expect(prompt).toContain("AGENT_RUNNER_OPEN_PR_CONTEXT_START");
    expect(prompt).toContain("AGENT_RUNNER_OPEN_PR_CONTEXT_END");
  });
});

describe("loadIdleOpenPrData", () => {
  const repo = { owner: "metyatech", repo: "demo" };

  it("starts open PR list and count fetches in parallel", async () => {
    let resolveList!: (value: any[]) => void;
    let listSettled = false;
    let countStartedBeforeListSettled = false;
    const listPromise = new Promise<any[]>((resolve) => {
      resolveList = (value) => {
        listSettled = true;
        resolve(value);
      };
    });
    const client = {
      listOpenPullRequests: () => listPromise,
      getOpenPullRequestCount: async () => {
        countStartedBeforeListSettled = !listSettled;
        return 1;
      }
    } as any;

    const pending = loadIdleOpenPrData(client, repo, {
      maxOpenPullRequests: 50,
      maxContextEntries: 50,
      maxContextChars: 12_000,
      warn: () => {}
    });

    resolveList([
      {
        number: 10,
        title: "Existing work",
        body: null,
        url: "https://github.com/metyatech/demo/pull/10",
        updatedAt: "2026-02-11T10:00:00Z",
        author: "metyatech"
      }
    ]);

    const loaded = await pending;
    expect(countStartedBeforeListSettled).toBe(true);
    expect(loaded.openPrCount).toBe(1);
    expect(loaded.openPrContextAvailable).toBe(true);
    expect(loaded.openPrContext).toContain("#10 Existing work");
  });

  it("keeps open PR count when list fetch fails", async () => {
    const warnings: string[] = [];
    const client = {
      listOpenPullRequests: async () => {
        throw new Error("list failed");
      },
      getOpenPullRequestCount: async () => 17
    } as any;

    const loaded = await loadIdleOpenPrData(client, repo, {
      maxOpenPullRequests: 50,
      maxContextEntries: 50,
      maxContextChars: 12_000,
      warn: (message) => warnings.push(message)
    });

    expect(loaded.openPrContextAvailable).toBe(false);
    expect(loaded.openPrCount).toBe(17);
    expect(loaded.openPrContext).toContain("Open PR context unavailable due to GitHub API error.");
    expect(warnings.join("\n")).toContain("Failed to load open PR context");
  });
});


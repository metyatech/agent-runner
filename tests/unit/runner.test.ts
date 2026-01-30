import { describe, expect, it } from "vitest";
import { buildCodexInvocation } from "../../src/runner.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("buildCodexInvocation", () => {
  it("builds args without shell splitting", () => {
    const invocation = buildCodexInvocation(
      {
        workdirRoot: "D:\\ghws",
        labels: {
          request: "agent:request",
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUser: "agent:needs-user"
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
          request: "agent:request",
          queued: "agent:queued",
          running: "agent:running",
          done: "agent:done",
          failed: "agent:failed",
          needsUser: "agent:needs-user"
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
            request: "agent:request",
            queued: "agent:queued",
            running: "agent:running",
            done: "agent:done",
            failed: "agent:failed",
            needsUser: "agent:needs-user"
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
